/**
 * Showing a server's storage health.
 *
 * Reads only, like the cluster view: this is what someone opens when inserts
 * start failing, and it must not be able to add to the trouble.
 */
import * as vscode from 'vscode';
import { ConnectionManager } from '../client/connectionManager';
import { ExplorerNode } from '../client/explorerView';
import { fetchHealth } from './fetch';
import { HealthPanel } from './panel';
import { healthFindings } from './rules';
import { HealthView } from './types';

export function registerHealthCommands(connections: ConnectionManager): vscode.Disposable[] {
    let scope: HealthView['scope'];
    const panel = new HealthPanel(() => void load());

    async function load(): Promise<void> {
        const client = await connections.client();
        if (!client) {
            panel.status('No connection is selected.');
            return;
        }
        panel.status('Reading storage state…');
        try {
            const view = await fetchHealth(client, scope);
            panel.showHealth(view, healthFindings(view));
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            panel.status(`Could not read storage health: ${message}`);
        }
    }

    return [
        panel,
        // From a table in the explorer it narrows to that table; from the
        // palette, the server or the cluster it looks at everything.
        vscode.commands.registerCommand('clickhouse.showTableHealth', async (node?: ExplorerNode) => {
            if (!(await connections.client())) {
                vscode.window.showWarningMessage('ClickHouse: no connection selected.');
                return;
            }
            scope = node?.kind === 'table' ? { database: node.database, table: node.table.name } : undefined;
            panel.show(scope ? `Health — ${scope.database}.${scope.table}` : 'Storage Health');
            await load();
        }),
    ];
}
