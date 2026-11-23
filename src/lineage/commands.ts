/**
 * Showing how a table is fed.
 */
import * as vscode from 'vscode';
import { ConnectionManager } from '../client/connectionManager';
import { ExplorerNode } from '../client/explorerView';
import { fetchLineage } from './fetch';
import { LineageGraph, connectedTables, lineageFindings, lineageOf, qualify } from './graph';
import { LineagePanel } from './panel';
import { renderLineage } from './render';

export function registerLineageCommands(connections: ConnectionManager): vscode.Disposable[] {
    let focus: string | undefined;

    function draw(graph: LineageGraph, name: string): void {
        const { upstream, downstream } = lineageOf(graph, name);
        const names = new Set<string>();
        const collect = (node: typeof upstream): void => {
            if (node.row && !node.cycle) names.add(node.name);
            node.children.forEach(collect);
        };
        collect(upstream);
        collect(downstream);
        panel.showLineage(renderLineage(name, upstream, downstream, lineageFindings(graph, name)), names);
    }

    async function load(): Promise<LineageGraph | undefined> {
        const client = await connections.client();
        if (!client) {
            panel.status('No connection is selected.');
            return undefined;
        }
        panel.status('Reading table definitions…');
        try {
            return await fetchLineage(client);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            panel.status(`Could not read system.tables: ${message}`);
            return undefined;
        }
    }

    async function showFor(name: string): Promise<void> {
        focus = name;
        panel.show(`Lineage — ${name}`);
        const graph = await load();
        if (graph) draw(graph, name);
    }

    const panel = new LineagePanel(
        () => focus && void showFor(focus),
        table => void showFor(table)
    );

    return [
        panel,
        // From a table in the explorer it starts there; from the palette it
        // offers the tables that actually take part in something.
        vscode.commands.registerCommand('clickhouse.showTableLineage', async (node?: ExplorerNode) => {
            if (!(await connections.client())) {
                vscode.window.showWarningMessage('ClickHouse: no connection selected.');
                return;
            }
            if (node?.kind === 'table') {
                await showFor(qualify(node.database, node.table.name));
                return;
            }

            const client = await connections.client();
            if (!client) return;
            let graph: LineageGraph;
            try {
                graph = await fetchLineage(client);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                vscode.window.showWarningMessage(`ClickHouse: could not read table definitions — ${message}`);
                return;
            }
            const names = connectedTables(graph);
            if (names.length === 0) {
                vscode.window.showInformationMessage(
                    'ClickHouse: no table here feeds another through a materialized view, Distributed or Buffer table.'
                );
                return;
            }
            const picked = await vscode.window.showQuickPick(names, {
                placeHolder: 'Show lineage for which table?',
            });
            if (!picked) return;

            focus = picked;
            panel.show(`Lineage — ${picked}`);
            draw(graph, picked);
        }),
    ];
}
