/**
 * Which icon stands for which table engine. Pure data, so the explorer and the
 * webview pages can share it without either importing the other.
 */

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
