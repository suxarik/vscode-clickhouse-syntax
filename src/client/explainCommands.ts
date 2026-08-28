/**
 * The EXPLAIN command and the read-only document it opens.
 */
import * as vscode from 'vscode';
import { AnalysisCache } from '../analysis';
import { buildExplainDocument } from './explain';
import { ConnectionManager } from './connectionManager';
import { resolveTarget } from './queryRunner';
import { ClickHouseError } from './types';

export const EXPLAIN_SCHEME = 'clickhouse-explain';

/** EXPLAIN kinds worth offering, with what each is for. */
const KINDS: Array<{ label: string; expression: string; detail: string }> = [
    { label: 'PLAN', expression: 'PLAN indexes = 1', detail: 'Query plan with index and granule pruning' },
    { label: 'PIPELINE', expression: 'PIPELINE', detail: 'Execution pipeline and its processors' },
    { label: 'ESTIMATE', expression: 'ESTIMATE', detail: 'Parts, rows and marks the query would read' },
    { label: 'SYNTAX', expression: 'SYNTAX', detail: 'The query after ClickHouse rewrites it' },
    { label: 'AST', expression: 'AST', detail: 'Parsed syntax tree' },
];

/** Holds rendered plans so the editor can show them as documents. */
export class ExplainDocumentProvider implements vscode.TextDocumentContentProvider {
    private readonly contents = new Map<string, string>();
    private readonly changed = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this.changed.event;

    provideTextDocumentContent(uri: vscode.Uri): string {
        return this.contents.get(uri.toString()) ?? '';
    }

    set(uri: vscode.Uri, content: string): void {
        this.contents.set(uri.toString(), content);
        this.changed.fire(uri);
    }
}

export function registerExplainCommands(
    connections: ConnectionManager,
    analysisCache: AnalysisCache,
    provider: ExplainDocumentProvider
): vscode.Disposable[] {
    return [
        vscode.workspace.registerTextDocumentContentProvider(EXPLAIN_SCHEME, provider),

        vscode.commands.registerCommand('clickhouse.explainQuery', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;

            const target = resolveTarget(editor.document, editor.selection, analysisCache);
            if (!target) {
                vscode.window.showInformationMessage('ClickHouse: nothing to explain at the cursor.');
                return;
            }

            const picked = await vscode.window.showQuickPick(KINDS, { placeHolder: 'Explain what?' });
            if (!picked) return;

            const profile = connections.activeProfileName();
            const client = await connections.client();
            if (!client || !profile) {
                vscode.window.showWarningMessage('ClickHouse: no connection selected.');
                return;
            }

            // Strip a trailing semicolon so EXPLAIN wraps a single statement.
            const sql = target.sql.replace(/;\s*$/, '');

            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Window, title: `ClickHouse: EXPLAIN ${picked.label}` },
                async () => {
                    try {
                        // EXPLAIN only ever reads, whatever the statement inside it does.
                        const result = await client.query(`EXPLAIN ${picked.expression} ${sql}`, {
                            readOnly: true,
                            maxExecutionTime: 30,
                        });
                        const raw = result.rows.map(row => String(row[0] ?? '')).join('\n');
                        const content = buildExplainDocument({
                            kind: picked.label,
                            sql,
                            profile,
                            raw,
                        });

                        const uri = vscode.Uri.parse(
                            `${EXPLAIN_SCHEME}:/${picked.label.toLowerCase()}-${Date.now()}.explain`
                        );
                        provider.set(uri, content);
                        const document = await vscode.workspace.openTextDocument(uri);
                        await vscode.window.showTextDocument(document, {
                            viewColumn: vscode.ViewColumn.Beside,
                            preview: true,
                        });
                    } catch (error) {
                        const message =
                            error instanceof ClickHouseError
                                ? `${error.message}${error.code !== undefined ? ` (code ${error.code})` : ''}`
                                : String(error);
                        vscode.window.showErrorMessage(`ClickHouse: EXPLAIN failed - ${message}`);
                    }
                }
            );
        }),
    ];
}
