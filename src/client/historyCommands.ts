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

const PIN_BUTTON: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('pin'),
    tooltip: 'Pin this query',
};
const UNPIN_BUTTON: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('pinned'),
    tooltip: 'Unpin this query',
};

/** A history item carries its entry, so the picker never indexes back by position. */
interface HistoryItem extends vscode.QuickPickItem {
    entry?: HistoryEntry;
}

function summarise(entry: HistoryEntry): HistoryItem {
    const when = new Date(entry.at).toLocaleString();
    const outcome = entry.error
        ? `failed: ${entry.error.slice(0, 60)}`
        : `${formatCount(entry.rows)} rows in ${formatDuration(entry.elapsedMs)}`;
    return {
        label: entry.label ?? entry.sql.replace(/\s+/g, ' ').slice(0, 100),
        description: entry.label ? `${entry.profile}  -  ${entry.sql.replace(/\s+/g, ' ').slice(0, 60)}` : entry.profile,
        detail: `${when}  -  ${outcome}`,
        buttons: [entry.pinned ? UNPIN_BUTTON : PIN_BUTTON],
        entry,
    };
}

/** Pinned first under their own heading, so a kept query is easy to find again. */
function buildItems(entries: HistoryEntry[]): HistoryItem[] {
    const pinned = entries.filter(e => e.pinned);
    const recent = entries.filter(e => !e.pinned);
    const items: HistoryItem[] = [];
    if (pinned.length > 0) {
        items.push({ label: 'Pinned', kind: vscode.QuickPickItemKind.Separator });
        items.push(...pinned.map(summarise));
        if (recent.length > 0) items.push({ label: 'Recent', kind: vscode.QuickPickItemKind.Separator });
    }
    items.push(...recent.map(summarise));
    return items;
}

/**
 * Show the history picker, returning the entry to run.
 *
 * This is a full quick pick rather than `showQuickPick` because pinning happens
 * through the per-item button, and the list has to stay open and re-render
 * afterwards - pinning three queries should not mean opening the picker three
 * times.
 */
function pickFromHistory(history: QueryHistory): Promise<HistoryEntry | undefined> {
    return new Promise(resolve => {
        const picker = vscode.window.createQuickPick<HistoryItem>();
        picker.placeholder = 'Run a query from history';
        picker.matchOnDetail = true;
        picker.matchOnDescription = true;
        picker.items = buildItems(history.entries());

        let result: HistoryEntry | undefined;

        picker.onDidTriggerItemButton(async event => {
            const entry = event.item.entry;
            if (!entry) return;
            await history.setPinned(entry.queryId, !entry.pinned);
            // Keep what was typed, so toggling a pin does not lose the filter.
            const value = picker.value;
            picker.items = buildItems(history.entries());
            picker.value = value;
        });

        picker.onDidAccept(() => {
            result = picker.selectedItems[0]?.entry;
            picker.hide();
        });
        picker.onDidHide(() => {
            picker.dispose();
            resolve(result);
        });
        picker.show();
    });
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
            if (history.entries().length === 0) {
                vscode.window.showInformationMessage('ClickHouse: no queries have been run in this workspace yet.');
                return;
            }

            const chosen = await pickFromHistory(history);
            if (!chosen) return;
            await runner.run({ sql: chosen.sql, statements: analysisCache.analyze(chosen.sql).program.statements });
        }),

        vscode.commands.registerCommand('clickhouse.clearQueryHistory', async () => {
            const pinnedCount = history.pinned().length;
            if (pinnedCount > 0) {
                // Clearing must not quietly discard what was deliberately kept.
                const keep = `Keep ${pinnedCount} pinned`;
                const answer = await vscode.window.showWarningMessage(
                    `ClickHouse: clear query history? ${pinnedCount} pinned ${pinnedCount === 1 ? 'query' : 'queries'} can be kept.`,
                    { modal: true },
                    keep,
                    'Clear everything'
                );
                if (!answer) return;
                await history.clear({ includePinned: answer !== keep });
                vscode.window.showInformationMessage(
                    answer === keep
                        ? `ClickHouse: history cleared, ${pinnedCount} pinned kept.`
                        : 'ClickHouse: query history cleared, including pins.'
                );
                return;
            }
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
