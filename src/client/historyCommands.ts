/**
 * History and profiling commands.
 */
import * as vscode from 'vscode';
import { formatBytes, formatCount, formatDuration } from '../results/format';
import { ConnectionManager } from './connectionManager';
import { fetchProfile, HistoryEntry, QueryHistory } from './history';
import { QueryRunner } from './queryRunner';
import { AnalysisCache } from '../analysis';
import { LiveValidator } from './liveDiagnostics';

function summarise(entry: HistoryEntry): vscode.QuickPickItem {
    const when = new Date(entry.at).toLocaleString();
    const outcome = entry.error
        ? `failed: ${entry.error.slice(0, 60)}`
        : `${formatCount(entry.rows)} rows in ${formatDuration(entry.elapsedMs)}`;
    return {
        label: entry.sql.replace(/\s+/g, ' ').slice(0, 100),
        description: entry.profile,
        detail: `${when}  -  ${outcome}`,
    };
}

export function registerHistoryCommands(
    history: QueryHistory,
    runner: QueryRunner,
    connections: ConnectionManager,
    analysisCache: AnalysisCache,
    validator: LiveValidator
): vscode.Disposable[] {
    return [
        vscode.commands.registerCommand('clickhouse.showQueryHistory', async () => {
            const entries = history.entries();
            if (entries.length === 0) {
                vscode.window.showInformationMessage('ClickHouse: no queries have been run in this workspace yet.');
                return;
            }

            const items = entries.map(summarise);
            const picked = await vscode.window.showQuickPick(items, {
                placeHolder: 'Run a query from history',
                matchOnDetail: true,
            });
            if (!picked) return;

            const entry = entries[items.indexOf(picked)];
            if (!entry) return;
            await runner.run({ sql: entry.sql, statements: analysisCache.analyze(entry.sql).program.statements });
        }),

        vscode.commands.registerCommand('clickhouse.clearQueryHistory', async () => {
            await history.clear();
            vscode.window.showInformationMessage('ClickHouse: query history cleared.');
        }),

        vscode.commands.registerCommand('clickhouse.profileLastQuery', async () => {
            const entry = history.latest();
            if (!entry) {
                vscode.window.showInformationMessage('ClickHouse: no query to profile yet.');
                return;
            }
            const client = await connections.client(entry.profile);
            if (!client) {
                vscode.window.showWarningMessage(`ClickHouse: profile '${entry.profile}' is not available.`);
                return;
            }

            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Window, title: 'ClickHouse: reading system.query_log' },
                async () => {
                    try {
                        const profile = await fetchProfile(client, entry.queryId);
                        if (!profile) {
                            vscode.window.showInformationMessage(
                                'ClickHouse: that query is not in system.query_log yet. The log is flushed periodically - try again shortly.'
                            );
                            return;
                        }

                        const channel = vscode.window.createOutputChannel('ClickHouse Query Profile');
                        channel.clear();
                        channel.appendLine(entry.sql.trim());
                        channel.appendLine('');
                        channel.appendLine(`profile        ${entry.profile}`);
                        channel.appendLine(`query id       ${profile.queryId}`);
                        channel.appendLine(`duration       ${formatDuration(profile.durationMs)}`);
                        channel.appendLine(`rows read      ${formatCount(profile.readRows)}`);
                        channel.appendLine(`bytes read     ${formatBytes(profile.readBytes)}`);
                        channel.appendLine(`rows returned  ${formatCount(profile.resultRows)}`);
                        channel.appendLine(`peak memory    ${formatBytes(profile.memoryBytes)}`);
                        channel.appendLine(`threads        ${profile.threads}`);
                        if (profile.exception) {
                            channel.appendLine('');
                            channel.appendLine(`exception      ${profile.exception}`);
                        }
                        channel.show(true);
                    } catch (error) {
                        vscode.window.showErrorMessage(
                            `ClickHouse: could not read system.query_log - ${error instanceof Error ? error.message : String(error)}`
                        );
                    }
                }
            );
        }),

        vscode.commands.registerCommand('clickhouse.validateWithServer', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
            await validator.validate(editor.document);
        }),
    ];
}
