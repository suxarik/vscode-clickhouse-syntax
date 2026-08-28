/**
 * Validating a document against the real server.
 *
 * The local rules catch what can be known without a connection; ClickHouse
 * itself catches the rest. `EXPLAIN QUERY TREE` resolves every name without
 * reading a single row, so an unknown column or table is reported while a full
 * table scan is not paid for. (`EXPLAIN SYNTAX` only parses - it accepts a
 * column that does not exist - which is why it is not used here.)
 *
 * This is on demand rather than on every keystroke: it is a network round trip
 * per statement, and a linter that quietly hammers production is not a linter
 * anyone wants.
 */
import * as vscode from 'vscode';
import { AnalysisCache } from '../analysis';
import { ConnectionManager } from './connectionManager';
import { classifyStatement } from './safety';
import { ClickHouseError } from './types';

export const LIVE_SOURCE = 'clickhouse (server)';

/**
 * ClickHouse reports a character offset for syntax errors:
 * `Syntax error: failed at position 15 ('FROM')`.
 */
export function parseErrorPosition(message: string): number | undefined {
    const match = /failed at position (\d+)/i.exec(message);
    if (!match) return undefined;
    const position = Number.parseInt(match[1], 10);
    return Number.isFinite(position) ? Math.max(0, position - 1) : undefined;
}

export function createLiveDiagnosticCollection(): vscode.DiagnosticCollection {
    return vscode.languages.createDiagnosticCollection('clickhouse-server');
}

export class LiveValidator {
    /**
     * `QUERY TREE` needs the analyzer, which is standard from ClickHouse 24.3.
     * Older servers reject it, so the first failure downgrades to `PLAN`, which
     * resolves names too but also builds a plan.
     */
    private explainKind: 'QUERY TREE' | 'PLAN' = 'QUERY TREE';

    constructor(
        private readonly connections: ConnectionManager,
        private readonly analysisCache: AnalysisCache,
        private readonly collection: vscode.DiagnosticCollection
    ) {}

    clear(document: vscode.TextDocument): void {
        this.collection.delete(document.uri);
    }

    async validate(document: vscode.TextDocument): Promise<void> {
        const profile = this.connections.activeProfileName();
        const client = await this.connections.client();
        if (!client || !profile) {
            vscode.window.showWarningMessage('ClickHouse: no connection selected, so there is nothing to validate against.');
            return;
        }

        const { program } = this.analysisCache.get(document);
        const statements = program.statements;
        if (statements.length === 0) {
            this.collection.delete(document.uri);
            return;
        }

        const diagnostics: vscode.Diagnostic[] = [];

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Window,
                title: `ClickHouse: validating against '${profile}'`,
            },
            async () => {
                for (const statement of statements) {
                    const text = document.getText().slice(statement.start, statement.end).trim();
                    if (!text) continue;

                    // Only reads can be validated safely: EXPLAIN of an INSERT
                    // still plans the SELECT behind it, but DDL is left alone.
                    const summary = classifyStatement(statement);
                    if (summary.effect !== 'read' && statement.kind !== 'InsertStatement') continue;

                    const sql = text.replace(/;\s*$/, '');
                    // ClickHouse reports positions against what it was sent, so
                    // the EXPLAIN prefix has to come back off again.
                    const prefixLength = `EXPLAIN ${this.explainKind} `.length;
                    try {
                        await client.query(`EXPLAIN ${this.explainKind} ${sql}`, {
                            readOnly: true,
                            maxExecutionTime: 15,
                            maxRows: 1,
                        });
                    } catch (error) {
                        if (this.shouldDowngrade(error)) {
                            this.explainKind = 'PLAN';
                            try {
                                await client.query(`EXPLAIN PLAN ${sql}`, {
                                    readOnly: true,
                                    maxExecutionTime: 15,
                                    maxRows: 1,
                                });
                                continue;
                            } catch (retryError) {
                                diagnostics.push(
                                    this.toDiagnostic(
                                        document,
                                        statement.start,
                                        statement.end,
                                        retryError,
                                        'EXPLAIN PLAN '.length
                                    )
                                );
                                continue;
                            }
                        }
                        diagnostics.push(
                            this.toDiagnostic(document, statement.start, statement.end, error, prefixLength)
                        );
                    }
                }
            }
        );

        this.collection.set(document.uri, diagnostics);

        if (diagnostics.length === 0) {
            vscode.window.setStatusBarMessage(`ClickHouse: '${profile}' accepted every statement`, 4000);
        }
    }

    /** A server too old for `QUERY TREE` rejects it as a syntax error. */
    private shouldDowngrade(error: unknown): boolean {
        if (this.explainKind !== 'QUERY TREE') return false;
        if (!(error instanceof ClickHouseError)) return false;
        return /QUERY\s+TREE/i.test(error.message);
    }

    private toDiagnostic(
        document: vscode.TextDocument,
        start: number,
        end: number,
        error: unknown,
        prefixLength = 0
    ): vscode.Diagnostic {
        const message = error instanceof ClickHouseError ? error.message : String(error);
        const code = error instanceof ClickHouseError ? error.code : undefined;

        // Point at the offending token when ClickHouse says where it is, after
        // discounting the EXPLAIN prefix it was measuring against. A position
        // past the statement means it landed in the format suffix, so fall back
        // to underlining the whole statement.
        const reported = parseErrorPosition(message);
        const offset =
            reported === undefined || reported < prefixLength || start + (reported - prefixLength) >= end
                ? undefined
                : reported - prefixLength;
        const from = offset === undefined ? start : start + offset;
        const to = offset === undefined ? end : Math.min(from + 1, end);

        const range = new vscode.Range(document.positionAt(from), document.positionAt(Math.max(to, from + 1)));
        const diagnostic = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Error);
        diagnostic.source = LIVE_SOURCE;
        if (code !== undefined) diagnostic.code = code;
        return diagnostic;
    }
}
