/**
 * The ClickHouse explorer: databases, tables and columns for the active profile.
 *
 * The tree reads whatever schema is loaded, so it works against a live server or
 * a committed schema file. Row counts and sizes are a separate, slower query, so
 * they are fetched once in the background and folded in when they arrive.
 */
import * as vscode from 'vscode';
import { SchemaManager } from '../schemaManager';
import { SchemaColumn, SchemaTable } from '../types';
import { formatBytes, formatCount } from '../results/format';
import { ConnectionManager } from './connectionManager';
import { TableStatistics, tableStatistics } from './introspection';

export type ExplorerNode =
    | { kind: 'message'; text: string }
    | { kind: 'database'; name: string }
    | { kind: 'table'; database: string; table: SchemaTable }
    | { kind: 'column'; database: string; table: string; column: SchemaColumn };

/** `db.table`, quoting only the parts that need it. */
export function qualifiedName(database: string, table: string): string {
    const quote = (part: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(part) ? part : `\`${part}\``);
    return `${quote(database)}.${quote(table)}`;
}

export class ExplorerProvider implements vscode.TreeDataProvider<ExplorerNode> {
    private readonly changed = new vscode.EventEmitter<ExplorerNode | undefined>();
    readonly onDidChangeTreeData = this.changed.event;

    private statistics = new Map<string, TableStatistics>();
    private statisticsProfile: string | undefined;

    constructor(
        private readonly schemaManager: SchemaManager,
        private readonly connections: ConnectionManager
    ) {}

    refresh(): void {
        this.changed.fire(undefined);
    }

    /** Drop statistics too; called when the profile or schema changes. */
    reset(): void {
        this.statistics.clear();
        this.statisticsProfile = undefined;
        this.refresh();
    }

    getTreeItem(node: ExplorerNode): vscode.TreeItem {
        switch (node.kind) {
            case 'message': {
                const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
                item.contextValue = 'clickhouse.message';
                return item;
            }

            case 'database': {
                const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Collapsed);
                item.iconPath = new vscode.ThemeIcon('database');
                item.contextValue = 'clickhouse.database';
                const tables = this.schemaManager.getTables(node.name).length;
                item.description = `${tables} table${tables === 1 ? '' : 's'}`;
                return item;
            }

            case 'table': {
                const item = new vscode.TreeItem(node.table.name, vscode.TreeItemCollapsibleState.Collapsed);
                item.iconPath = new vscode.ThemeIcon('table');
                item.contextValue = 'clickhouse.table';

                const stats = this.statistics.get(`${node.database}.${node.table.name}`);
                item.description = [
                    node.table.engine,
                    stats ? `${formatCount(stats.rows)} rows` : undefined,
                    stats ? formatBytes(stats.bytesOnDisk) : undefined,
                ]
                    .filter(Boolean)
                    .join('  ');

                const tooltip = new vscode.MarkdownString();
                tooltip.appendMarkdown(`**${qualifiedName(node.database, node.table.name)}**\n\n`);
                if (node.table.description) tooltip.appendMarkdown(`${node.table.description}\n\n`);
                if (node.table.engine) tooltip.appendMarkdown(`Engine: \`${node.table.engine}\`\n\n`);
                tooltip.appendMarkdown(`Columns: ${node.table.columns.length}`);
                if (stats) {
                    tooltip.appendMarkdown(
                        `\n\nRows: ${formatCount(stats.rows)}` +
                            `\n\nOn disk: ${formatBytes(stats.bytesOnDisk)}` +
                            ` (uncompressed ${formatBytes(stats.uncompressedBytes)}, ${stats.parts} parts)`
                    );
                }
                item.tooltip = tooltip;
                return item;
            }

            case 'column': {
                const item = new vscode.TreeItem(node.column.name, vscode.TreeItemCollapsibleState.None);
                item.iconPath = new vscode.ThemeIcon('symbol-field');
                item.contextValue = 'clickhouse.column';
                item.description = node.column.type;
                const tooltip = new vscode.MarkdownString();
                tooltip.appendMarkdown(`**${node.column.name}** \`${node.column.type}\`\n\n`);
                if (node.column.description) tooltip.appendMarkdown(`${node.column.description}\n\n`);
                if (node.column.defaultValue) tooltip.appendMarkdown(`Default: \`${node.column.defaultValue}\`\n\n`);
                if (node.column.codec) tooltip.appendMarkdown(`Codec: \`${node.column.codec}\``);
                item.tooltip = tooltip;
                return item;
            }
        }
    }

    getChildren(node?: ExplorerNode): ExplorerNode[] {
        const schema = this.schemaManager.getSchema();

        if (!node) {
            if (!schema || schema.databases.length === 0) {
                return [
                    {
                        kind: 'message',
                        text: this.connections.activeProfileName()
                            ? 'No schema loaded - run ClickHouse: Reload Schema'
                            : 'No connection selected',
                    },
                ];
            }
            void this.loadStatistics();
            return schema.databases
                .map(database => ({ kind: 'database' as const, name: database.name }))
                .sort((a, b) => a.name.localeCompare(b.name));
        }

        if (node.kind === 'database') {
            return this.schemaManager
                .getTables(node.name)
                .map(entry => ({ kind: 'table' as const, database: entry.db, table: entry.table }))
                .sort((a, b) => a.table.name.localeCompare(b.table.name));
        }

        if (node.kind === 'table') {
            return node.table.columns.map(column => ({
                kind: 'column' as const,
                database: node.database,
                table: node.table.name,
                column,
            }));
        }

        return [];
    }

    /** Row counts and sizes, once per profile, in the background. */
    private async loadStatistics(): Promise<void> {
        const profile = this.connections.activeProfileName();
        if (!profile || this.statisticsProfile === profile) return;
        this.statisticsProfile = profile;

        const client = await this.connections.client(profile);
        if (!client) return;

        try {
            const rows = await tableStatistics(client);
            this.statistics = new Map(rows.map(row => [`${row.database}.${row.table}`, row]));
            this.refresh();
        } catch (error) {
            // A user without rights on system.parts still gets a usable tree.
            console.error('ClickHouse: could not read table statistics', error);
        }
    }
}
