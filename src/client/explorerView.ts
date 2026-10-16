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
    | { kind: 'server' }
    | { kind: 'database'; name: string }
    | { kind: 'table'; database: string; table: SchemaTable }
    | { kind: 'column'; database: string; table: string; column: SchemaColumn };

/** `db.table`, quoting only the parts that need it. */
export function qualifiedName(database: string, table: string): string {
    const quote = (part: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(part) ? part : `\`${part}\``);
    return `${quote(database)}.${quote(table)}`;
}

/**
 * The icon for a table engine.
 *
 * The engine is already written in the description, but a list of forty tables
 * is scanned rather than read. What matters at a glance is the kind of thing:
 * a ReplacingMergeTree that needs FINAL, a view that is not storage at all, a
 * table whose rows actually live in S3.
 */
const ENGINE_ICONS: Array<[RegExp, string]> = [
    // Views and other things that hold no rows of their own.
    [/^MaterializedView$/, 'zap'],
    [/View$/, 'eye'],
    [/^Dictionary$/, 'book'],
    [/^Distributed$/, 'type-hierarchy'],
    [/^Merge$/, 'merge'],
    [/^Buffer$/, 'inbox'],
    [/^Null$/, 'circle-slash'],
    [/^(Memory|Set|Join|KeeperMap)$/, 'references'],

    // MergeTree variants, which differ in what a read has to do about them.
    [/ReplacingMergeTree$/, 'versions'],
    [/(Summing|Aggregating|Coalescing)MergeTree$/, 'graph'],
    [/CollapsingMergeTree$/, 'fold'],
    [/GraphiteMergeTree$/, 'graph-line'],
    // Not 'database': that is the database node's icon, and a table wearing
    // it reads as a database sitting inside a database.
    [/MergeTree$/, 'layers'],

    // Queues and streams.
    [/^(Kafka|RabbitMQ|NATS)/, 'radio-tower'],
    [/Queue$/, 'radio-tower'],
    [/^FileLog$/, 'radio-tower'],

    // Rows that live somewhere else entirely.
    [/^(S3|COSN|GCS|AzureBlobStorage|HDFS|URL|File|ArrowFlight)$/, 'cloud'],
    [/^(Iceberg|DeltaLake|Hudi|Paimon)/, 'cloud'],
    [/^(MySQL|PostgreSQL|MaterializedPostgreSQL|MongoDB|SQLite|Redis|JDBC|ODBC|BigQuery|Oracle)/, 'plug'],
    [/^(TimeSeries|Prometheus)/, 'graph-line'],

    [/Log$/, 'output'],
];

/** `table` for anything newer than this list, which is better than nothing. */
export function engineIcon(engine: string | undefined): string {
    const name = (engine ?? '').trim();
    if (!name) return 'table';

    // Replication is a deployment choice, not a different kind of table.
    const family = name.replace(/^(Replicated|Shared)/, '');
    for (const [pattern, icon] of ENGINE_ICONS) {
        if (pattern.test(family)) return icon;
    }
    return 'table';
}

export class ExplorerProvider implements vscode.TreeDataProvider<ExplorerNode> {
    private readonly changed = new vscode.EventEmitter<ExplorerNode | undefined>();
    readonly onDidChangeTreeData = this.changed.event;

    private statistics = new Map<string, TableStatistics>();
    private statisticsProfile: string | undefined;
    /**
     * Whether the server we are connected to is one node or several.
     *
     * A single node still reports a `default` cluster containing only itself,
     * so the question is not whether a cluster exists but whether one has more
     * than one host in it.
     */
    private serverShape?: { profile: string; cluster?: { cluster: string; hosts: number } };

    private readonly subscription: vscode.Disposable;

    constructor(
        private readonly schemaManager: SchemaManager,
        private readonly connections: ConnectionManager
    ) {
        // The schema usually arrives after this tree has drawn itself empty.
        this.subscription = this.schemaManager.onDidChangeSchema(() => this.refresh());
    }

    dispose(): void {
        this.subscription.dispose();
    }

    refresh(): void {
        this.changed.fire(undefined);
    }

    /** Drop statistics too; called when the profile or schema changes. */
    reset(): void {
        this.statistics.clear();
        this.statisticsProfile = undefined;
        this.serverShape = undefined;
        this.refresh();
    }

    /** One query, the first time the tree is drawn for a profile. */
    private async loadServerShape(): Promise<void> {
        const profile = this.connections.activeProfileName();
        if (!profile || this.serverShape?.profile === profile) return;

        this.serverShape = { profile };
        const client = await this.connections.client(profile);
        if (!client) return;

        try {
            const answer = await client.query(
                'SELECT cluster, count() AS hosts FROM system.clusters ' +
                    'GROUP BY cluster HAVING hosts > 1 ORDER BY hosts DESC LIMIT 1',
                { readOnly: true, maxExecutionTime: 10 }
            );
            const row = answer.rows[0];
            if (row) {
                this.serverShape = {
                    profile,
                    cluster: { cluster: String(row[0] ?? ''), hosts: Number(row[1] ?? 0) },
                };
                this.refresh();
            }
        } catch {
            // A user without rights on system.clusters still gets a usable tree.
        }
    }

    /**
     * The colour a writable connection is marked in.
     *
     * VS Code will not colour a tree item's description, so the icon carries
     * it: on a profile that may write, the server, its databases and their
     * tables turn ClickHouse orange. It is worth knowing before anyone types,
     * not after a confirmation dialog appears.
     *
     * Columns are deliberately left alone. They are not something a connection
     * grants access to, and marking every row of an expanded tree reads as a
     * rendering fault rather than as a warning.
     */
    private writableTint(): vscode.ThemeColor | undefined {
        return this.connections.activeProfile()?.allowWrite === true
            ? new vscode.ThemeColor('clickhouse.writable')
            : undefined;
    }

    getTreeItem(node: ExplorerNode): vscode.TreeItem {
        switch (node.kind) {
            case 'server': {
                const profile = this.connections.activeProfileName() ?? 'ClickHouse';
                const cluster = this.serverShape?.cluster;
                // Expanded, so nesting the databases correctly does not put
                // them behind a click that was not there before.
                const item = new vscode.TreeItem(profile, vscode.TreeItemCollapsibleState.Expanded);

                const tint = this.writableTint();
                item.iconPath = new vscode.ThemeIcon(cluster ? 'type-hierarchy' : 'server', tint);
                item.description = [
                    cluster ? `${cluster.cluster} · ${cluster.hosts} nodes` : 'single node',
                    tint ? 'writable' : undefined,
                ]
                    .filter(Boolean)
                    .join(' · ');
                item.contextValue = cluster ? 'clickhouse.cluster' : 'clickhouse.server';
                if (cluster) {
                    item.command = { command: 'clickhouse.showCluster', title: 'Show Cluster' };
                    item.tooltip = `Connected to ${profile}, one node of the ${cluster.cluster} cluster`;
                } else {
                    item.tooltip = `Connected to ${profile}, which reports no cluster`;
                }
                return item;
            }

            case 'database': {
                const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Collapsed);
                item.iconPath = new vscode.ThemeIcon('database', this.writableTint());
                item.contextValue = 'clickhouse.database';
                const tables = this.schemaManager.getTables(node.name).length;
                item.description = `${tables} table${tables === 1 ? '' : 's'}`;
                return item;
            }

            case 'table': {
                const item = new vscode.TreeItem(node.table.name, vscode.TreeItemCollapsibleState.Collapsed);
                item.iconPath = new vscode.ThemeIcon(engineIcon(node.table.engine), this.writableTint());
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
            // An empty array lets the view's welcome content show instead, which
            // can offer "Add Connection" rather than stating a dead end.
            if (!schema || schema.databases.length === 0) return [];
            void this.loadStatistics();
            void this.loadServerShape();

            return [{ kind: 'server' as const }];
        }

        if (node.kind === 'server') {
            if (!schema) return [];
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
