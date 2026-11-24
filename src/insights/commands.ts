/**
 * Showing what a server has been asked.
 */
import * as vscode from 'vscode';
import { ConnectionManager } from '../client/connectionManager';
import { ExportFormat, exportShapes } from './export';
import { fetchInsights } from './fetch';
import { InsightsPanel } from './panel';
import { InsightsView, Lens, Window } from './types';

export function registerInsightsCommands(connections: ConnectionManager): vscode.Disposable[] {
    let lens: Lens = 'time';
    let hours: Window = 24;
    let shown: InsightsView | undefined;

    async function load(): Promise<void> {
        const client = await connections.client();
        if (!client) {
            panel.status('No connection is selected.');
            return;
        }
        panel.status('Reading system.query_log…');
        try {
            shown = await fetchInsights(client, lens, hours);
            panel.showInsights(shown);
        } catch (error) {
            shown = undefined;
            const message = error instanceof Error ? error.message : String(error);
            panel.status(
                `Could not read system.query_log: ${message}. ` +
                    'It needs the query log to be enabled and SELECT on the table.'
            );
        }
    }

    /** What the page was listing when the button was pressed, saved as a file. */
    async function save(format: ExportFormat, indices: number[]): Promise<void> {
        const view = shown;
        if (!view) return;
        const rows = indices
            .filter(index => index < view.shapes.length)
            .map(index => ({ shape: view.shapes[index], rank: index + 1 }));
        if (rows.length === 0) return;

        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        const target = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(`clickhouse-query-insights-${view.lens}-${stamp}.${format}`),
            filters: { [format.toUpperCase()]: [format] },
        });
        if (!target) return;
        await vscode.workspace.fs.writeFile(target, Buffer.from(exportShapes(rows, format), 'utf8'));
        vscode.window.setStatusBarMessage(`ClickHouse: ${rows.length} statements saved`, 3000);
    }

    const panel = new InsightsPanel({
        onRefresh: () => void load(),
        onChange: (nextLens, nextHours) => {
            lens = nextLens ?? lens;
            hours = nextHours ?? hours;
            void load();
        },
        // Opened as SQL rather than shown inline: it can be read, edited and run,
        // with Explain and Analyze above it, like Preview Rows.
        onOpen: index => {
            const example = shown?.shapes[index]?.example;
            if (!example) return;
            void vscode.workspace
                .openTextDocument({ language: 'clickhouse', content: `${example.trim()}\n` })
                .then(document => vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside }));
        },
        onExport: (format, indices) => void save(format, indices),
    });

    return [
        panel,
        vscode.commands.registerCommand('clickhouse.showQueryInsights', async () => {
            if (!(await connections.client())) {
                vscode.window.showWarningMessage('ClickHouse: no connection selected.');
                return;
            }
            panel.show('Query Insights');
            await load();
        }),
    ];
}
