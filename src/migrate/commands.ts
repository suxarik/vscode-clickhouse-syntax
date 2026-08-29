/**
 * The migration and scaffolding commands.
 *
 * Both end the same way: a read-only document you can read, edit and run
 * yourself. Nothing here applies anything. A tool that changes a production
 * schema on your behalf is a tool you have to audit before every use, which is
 * worse than writing the ALTER by hand.
 */
import * as vscode from 'vscode';
import { ConnectionManager } from '../client/connectionManager';
import { introspect } from '../client/introspection';
import { SchemaManager } from '../schemaManager';
import { SchemaColumn } from '../types';
import { Change, diffSchema, renderMigration } from './diff';
import { scaffold, ScaffoldRequest } from './scaffold';

/** Open generated SQL in an editor rather than writing it anywhere. */
async function showSql(content: string): Promise<void> {
    const document = await vscode.workspace.openTextDocument({ language: 'clickhouse', content });
    await vscode.window.showTextDocument(document, { preview: false });
}

/** A one-line summary for the notification, so the diff is not a surprise. */
function summarise(changes: Change[]): string {
    if (changes.length === 0) return 'the server already matches the schema file';
    const destructive = changes.filter(change => change.destructive).length;
    const safe = changes.length - destructive;
    const parts: string[] = [];
    if (safe > 0) parts.push(`${safe} safe`);
    if (destructive > 0) parts.push(`${destructive} that could lose data`);
    return `${changes.length} difference${changes.length === 1 ? '' : 's'} — ${parts.join(', ')}`;
}

/** Parse a comma-separated `name Type` list, which is how people type columns. */
export function parseColumnList(input: string): SchemaColumn[] {
    return input
        .split(',')
        .map(part => part.trim())
        .filter(Boolean)
        .map(part => {
            const at = part.indexOf(' ');
            if (at === -1) return { name: part, type: 'String' };
            return { name: part.slice(0, at), type: part.slice(at + 1).trim() };
        });
}

export function registerMigrationCommands(
    connections: ConnectionManager,
    schemaManager: SchemaManager
): vscode.Disposable[] {
    return [
        vscode.commands.registerCommand('clickhouse.diffSchema', async () => {
            const intended = schemaManager.getSchema();
            if (!intended) {
                const choice = await vscode.window.showWarningMessage(
                    'ClickHouse: there is no schema file to compare against.',
                    'Generate One'
                );
                if (choice === 'Generate One') {
                    await vscode.commands.executeCommand('clickhouse.generateSchemaTemplate');
                }
                return;
            }

            const profileName = connections.activeProfileName();
            const client = profileName ? await connections.client(profileName) : undefined;
            if (!client || !profileName) {
                vscode.window.showWarningMessage('ClickHouse: select a connection to compare against.');
                return;
            }

            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'ClickHouse: reading the live schema' },
                async () => {
                    try {
                        const live = await introspect(client, profileName);
                        const changes = diffSchema(intended, live);
                        await showSql(renderMigration(changes, { profile: profileName }));
                        vscode.window.showInformationMessage(`ClickHouse: ${summarise(changes)}.`);
                    } catch (error) {
                        vscode.window.showErrorMessage(
                            `ClickHouse: could not read the live schema — ${error instanceof Error ? error.message : String(error)}`
                        );
                    }
                }
            );
        }),

        vscode.commands.registerCommand('clickhouse.scaffoldTable', async () => {
            const table = await vscode.window.showInputBox({
                title: 'Scaffold a table (1/5)',
                prompt: 'Table name',
                placeHolder: 'events',
                ignoreFocusOut: true,
                validateInput: value => (value.trim() ? undefined : 'A name is required.'),
            });
            if (!table) return;

            const database = await vscode.window.showInputBox({
                title: 'Scaffold a table (2/5)',
                prompt: 'Database',
                value: connections.activeProfile()?.database ?? 'default',
                ignoreFocusOut: true,
            });
            if (database === undefined) return;

            const columnsInput = await vscode.window.showInputBox({
                title: 'Scaffold a table (3/5)',
                prompt: 'Columns, comma separated',
                value: 'event_date Date, event_time DateTime, user_id UInt64, event_type LowCardinality(String)',
                ignoreFocusOut: true,
                validateInput: value => (parseColumnList(value).length > 0 ? undefined : 'At least one column.'),
            });
            if (columnsInput === undefined) return;
            const columns = parseColumnList(columnsInput);

            const orderBy = await vscode.window.showInputBox({
                title: 'Scaffold a table (4/5)',
                prompt: 'ORDER BY — the primary key, and the single thing that decides whether queries are fast',
                value: columns.length > 1 ? `(${columns[0].name}, ${columns[1].name})` : columns[0].name,
                ignoreFocusOut: true,
            });
            if (orderBy === undefined) return;

            const cluster = await vscode.window.showInputBox({
                title: 'Scaffold a table (5/5)',
                prompt: 'Cluster name, or leave empty for a single node',
                placeHolder: 'leave empty for a single-node table',
                ignoreFocusOut: true,
            });
            if (cluster === undefined) return;

            const request: ScaffoldRequest = {
                database: database.trim() || 'default',
                table: table.trim(),
                columns,
                orderBy: orderBy.trim() || 'tuple()',
            };
            const dateColumn = columns.find(column => /^Date/.test(column.type));
            if (dateColumn) request.partitionBy = `toYYYYMM(${dateColumn.name})`;
            if (cluster.trim()) {
                request.cluster = cluster.trim();
                request.replicated = true;
            }

            await showSql(scaffold(request));
        }),
    ];
}
