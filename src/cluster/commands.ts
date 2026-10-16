/**
 * Showing a cluster.
 *
 * Everything here reads. A cluster is looked at during an incident, which is
 * exactly when a tool should not be able to make things worse.
 */
import * as vscode from 'vscode';
import { ConnectionManager } from '../client/connectionManager';
import { ClusterPanel } from './panel';
import { fetchCluster, listClusters } from './fetch';
import { clusterFindings } from './rules';

export function registerClusterCommands(
    connections: ConnectionManager,
    extensionUri: vscode.Uri
): vscode.Disposable[] {
    let current: string | undefined;
    const panel = new ClusterPanel(extensionUri, () => void load(current));

    async function load(cluster: string | undefined): Promise<void> {
        const client = await connections.client();
        if (!client || !cluster) {
            panel.post({ type: 'error', message: 'No connection is selected.' });
            return;
        }

        panel.post({ type: 'status', message: `Reading ${cluster}…` });
        try {
            const view = await fetchCluster(client, cluster);
            const tables = [
                ...new Set(view.placement.map(entry => `${entry.database}.${entry.table}`)),
            ].sort();

            panel.showCluster({ view, tables, fetchedAt: Date.now() });
            panel.post({ type: 'findings', findings: clusterFindings(view) });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            panel.post({ type: 'error', message: `Could not read the cluster: ${message}` });
        }
    }

    return [
        panel,
        vscode.commands.registerCommand('clickhouse.showCluster', async () => {
            const client = await connections.client();
            if (!client) {
                vscode.window.showWarningMessage('ClickHouse: no connection selected.');
                return;
            }

            let clusters: string[] = [];
            try {
                clusters = await listClusters(client);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                vscode.window.showWarningMessage(`ClickHouse: could not list clusters — ${message}`);
                return;
            }

            if (clusters.length === 0) {
                vscode.window.showInformationMessage(
                    'ClickHouse: this server reports no clusters. A single node has none to show.'
                );
                return;
            }

            const picked =
                clusters.length === 1
                    ? clusters[0]
                    : await vscode.window.showQuickPick(clusters, { placeHolder: 'Which cluster?' });
            if (!picked) return;

            current = picked;
            panel.show(`Cluster — ${picked}`);
            await load(picked);
        }),
    ];
}
