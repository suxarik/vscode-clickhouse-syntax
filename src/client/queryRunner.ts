/**
 * Running a statement and getting its result onto the screen.
 *
 * The safety model lives here: the statement is classified from the parse tree,
 * the gate decides whether it runs at all, and only then does anything reach the
 * network. Cancellation goes to the server as `KILL QUERY`, not just an aborted
 * socket, so the work actually stops.
 */
import * as vscode from 'vscode';
import { AnalysisCache } from '../analysis';
import { Statement } from '../parser/ast';
import { statementAt } from '../parser/walk';
import { ResultsPanel } from '../results/resultsPanel';
import { ConnectionManager } from './connectionManager';
import { ClickHouseClient, newQueryId } from './httpClient';
import { classifyStatement, gate, StatementSummary } from './safety';
import { QueryHistory } from './history';
import { ClickHouseError } from './types';

export interface RunTarget {
    sql: string;
    /** Statements the SQL contains, for classification. */
    statements: Statement[];
    /** Range to highlight while it runs. */
    range?: vscode.Range;
}

function describe(error: unknown): { message: string; code?: number } {
    if (error instanceof ClickHouseError) return { message: error.message, code: error.code };
    return { message: error instanceof Error ? error.message : String(error) };
}

/** The statement under the cursor, or the selection if there is one. */
export function resolveTarget(
    document: vscode.TextDocument,
    selection: vscode.Selection,
    analysisCache: AnalysisCache
): RunTarget | undefined {
    const analysis = analysisCache.get(document);

    if (!selection.isEmpty) {
        const sql = document.getText(selection);
        if (!sql.trim()) return undefined;
        // Re-analysing the selection alone keeps classification honest: what is
        // sent is exactly what is classified.
        const statements = analysisCache.analyze(sql).program.statements;
        return { sql, statements, range: selection };
    }

    const offset = document.offsetAt(selection.active);
    const statement = statementAt(analysis.program, offset) ?? nearestStatement(analysis.program.statements, offset);
    if (!statement) return undefined;

    const sql = document.getText().slice(statement.start, statement.end).trim();
    if (!sql) return undefined;
    return {
        sql,
        statements: [statement],
        range: new vscode.Range(document.positionAt(statement.start), document.positionAt(statement.end)),
    };
}

/** A cursor sitting in trailing whitespace still means the statement before it. */
function nearestStatement(statements: Statement[], offset: number): Statement | undefined {
    let best: Statement | undefined;
    for (const statement of statements) {
        if (statement.start <= offset) best = statement;
    }
    return best;
}

export class QueryRunner implements vscode.Disposable {
    private active: { client: ClickHouseClient; queryId: string; controller: AbortController } | undefined;

    /**
     * A running query needs to look like it is running.
     *
     * ClickHouse reports progress only in the summary at the end - there are no
     * usable in-flight progress headers - so this counts what has actually
     * arrived, which is honest and is what people want to know anyway.
     */
    private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);

    constructor(
        private readonly connections: ConnectionManager,
        private readonly panel: ResultsPanel,
        private readonly analysisCache: AnalysisCache,
        private readonly history?: QueryHistory
    ) {}

    /** Ask the user for whatever the gate requires. */
    private async permitted(summaries: StatementSummary[], profileName: string): Promise<boolean> {
        const profile = this.connections.activeProfile();
        const decision = gate({
            summaries,
            allowWrite: profile?.allowWrite === true,
            isProtected: profile?.protected === true,
            profileName,
        });

        switch (decision.action) {
            case 'run':
                return true;

            case 'refuse':
                vscode.window.showErrorMessage(`ClickHouse: ${decision.message}`);
                return false;

            case 'confirm': {
                const choice = await vscode.window.showWarningMessage(
                    decision.message,
                    { modal: true },
                    decision.confirmLabel
                );
                return choice === decision.confirmLabel;
            }

            case 'confirmTyped': {
                const typed = await vscode.window.showInputBox({
                    prompt: decision.message,
                    placeHolder: decision.expected,
                    ignoreFocusOut: true,
                    validateInput: value =>
                        value === decision.expected ? undefined : `Type "${decision.expected}" to confirm.`,
                });
                return typed === decision.expected;
            }
        }
    }

    async run(target: RunTarget): Promise<void> {
        const profileName = this.connections.activeProfileName();
        if (!profileName) {
            const choice = await vscode.window.showWarningMessage(
                'ClickHouse: no connection selected.',
                'Select Connection'
            );
            if (choice === 'Select Connection') {
                await vscode.commands.executeCommand('clickhouse.selectConnection');
            }
            return;
        }

        const summaries = target.statements.map(classifyStatement);
        if (!(await this.permitted(summaries, profileName))) return;

        const client = await this.connections.client(profileName);
        if (!client) return;

        const config = vscode.workspace.getConfiguration('clickhouse');
        const profile = this.connections.activeProfile();
        const queryId = newQueryId();
        const controller = new AbortController();

        this.active = { client, queryId, controller };
        const started = Date.now();
        this.showProgress(0, started);
        this.panel.noteTransport(client.transportName);
        this.panel.begin(
            {
                query: target.sql.length > 200 ? `${target.sql.slice(0, 199)}…` : target.sql,
                profile: profileName,
                queryId,
            },
            { onCancel: () => void this.cancel() }
        );

        try {
            const result = await client.query(target.sql, {
                queryId,
                signal: controller.signal,
                // Belt and braces: the gate already refused writes on a
                // read-only profile, and the server is told to refuse them too.
                readOnly: profile?.allowWrite !== true,
                maxRows: config.get<number>('query.maxResultRows', 100_000),
                maxExecutionTime: config.get<number>('query.maxExecutionTime', 60),
                // Columns are known before any row arrives, and the rows are
                // streamed once. Re-sending them at the end would double the
                // traffic and throw away what the view had already drawn.
                onColumns: columns => this.panel.setColumns(columns),
                onRows: (rows, total) => {
                    this.panel.appendRows(rows, total);
                    this.showProgress(total, started);
                },
                onTrace: note => this.panel.trace(note),
            });

            // The summary header is written when headers flush, so for a
            // streamed result it is a snapshot rather than a total - a million
            // rows can report sixty thousand read. Showing a number smaller
            // than what arrived is worse than showing none; Profile Last Query
            // reads the authoritative figures from system.query_log.
            const summary = result.summary;
            // Only a read count we can see is too small proves a snapshot; an
            // absent one contradicts nothing.
            const summaryIsComplete =
                summary?.readRows === undefined || summary.readRows >= result.rows.length;

            this.panel.end(
                {
                    elapsedMs: result.elapsedMs,
                    readRows: summaryIsComplete ? summary?.readRows : undefined,
                    readBytes: summaryIsComplete ? summary?.readBytes : undefined,
                    // The server reports result_rows as 0 for a streamed
                    // result, so what actually arrived is the honest number.
                    resultRows: summary?.resultRows || result.rows.length,
                    writtenRows: summary?.writtenRows,
                    memoryBytes: summaryIsComplete ? summary?.memoryBytes : undefined,
                },
                result.truncated
            );

            await this.history?.record({
                sql: target.sql,
                profile: profileName,
                queryId,
                at: Date.now(),
                elapsedMs: result.elapsedMs,
                rows: result.rows.length,
            });
        } catch (error) {
            if (controller.signal.aborted) this.panel.cancelled();
            else {
                const { message, code } = describe(error);
                this.panel.fail(message, code);
            }
            // A failed query is worth keeping: it is usually the one to revisit.
            await this.history?.record({
                sql: target.sql,
                profile: profileName,
                queryId,
                at: Date.now(),
                error: controller.signal.aborted ? 'cancelled' : describe(error).message,
            });
        } finally {
            this.active = undefined;
            this.status.hide();
        }
    }

    private showProgress(rows: number, started: number): void {
        const seconds = Math.round((Date.now() - started) / 1000);
        const counted = rows > 0 ? `${rows.toLocaleString()} rows` : 'waiting';
        this.status.text = `$(sync~spin) ClickHouse: ${counted}${seconds > 0 ? ` · ${seconds}s` : ''}`;
        this.status.tooltip = 'A query is running. Click to cancel.';
        this.status.command = 'clickhouse.cancelQuery';
        this.status.show();
    }

    dispose(): void {
        this.status.dispose();
    }

    /** Abort the request and ask the server to stop the work. */
    async cancel(): Promise<void> {
        const active = this.active;
        if (!active) return;
        active.controller.abort();
        try {
            await active.client.kill(active.queryId);
        } catch {
            // The query may already have finished; nothing to report.
        }
    }

    get isRunning(): boolean {
        return this.active !== undefined;
    }
}
