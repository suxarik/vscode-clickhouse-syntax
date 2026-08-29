/**
 * Scaffolding the table triple a ClickHouse cluster actually needs.
 *
 * A table on a cluster is rarely one object. It is a local MergeTree on every
 * shard, a Distributed table in front of it, and often a materialized view
 * feeding a rollup - three definitions that must agree about columns, keys and
 * cluster name. Writing them by hand is where they stop agreeing.
 *
 * Free of `vscode`: given a description, it returns SQL.
 */
import { columnClause, quoteIdentifier } from './diff';
import { SchemaColumn } from '../types';

export interface ScaffoldRequest {
    database: string;
    /** Base name. The local table gets `_local`, the view `_mv`. */
    table: string;
    columns: SchemaColumn[];
    orderBy: string;
    partitionBy?: string;
    /** Cluster name; without one only the local table is written. */
    cluster?: string;
    /** Column the Distributed table shards on. */
    shardingKey?: string;
    /** Engine for the local table. */
    engine?: string;
    ttl?: string;
    /** Also scaffold a rollup view aggregating over these columns. */
    rollup?: { groupBy: string[]; aggregate: string };
    /** Replicated engines need a ZooKeeper path. */
    replicated?: boolean;
}

const LOCAL_SUFFIX = '_local';

/**
 * The name of the table that actually holds the data.
 *
 * Only a clustered table needs the suffix, because only there is something else
 * taking the plain name. On a single node `events_local` with nothing in front
 * of it is a name that explains a distinction that does not exist.
 */
function localName(request: ScaffoldRequest): string {
    return request.cluster ? `${request.table}${LOCAL_SUFFIX}` : request.table;
}

/** The engine clause for the local table, replicated or not. */
function engineClause(request: ScaffoldRequest): string {
    const engine = request.engine ?? 'MergeTree';
    if (!request.replicated) return `${engine}()`;
    // The macro form, so the same DDL is correct on every replica.
    return `Replicated${engine}('/clickhouse/tables/{shard}/${request.database}/${localName(request)}', '{replica}')`;
}

function onCluster(request: ScaffoldRequest): string {
    return request.cluster ? ` ON CLUSTER ${quoteIdentifier(request.cluster)}` : '';
}

/** The local MergeTree that holds the data on each shard. */
export function localTableSql(request: ScaffoldRequest): string {
    const columns = request.columns.map(column => `    ${columnClause(column)}`).join(',\n');
    const lines = [
        `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(request.database)}.${quoteIdentifier(localName(request))}${onCluster(request)}`,
        '(',
        columns,
        ')',
        `ENGINE = ${engineClause(request)}`,
    ];
    if (request.partitionBy) lines.push(`PARTITION BY ${request.partitionBy}`);
    lines.push(`ORDER BY ${request.orderBy}`);
    if (request.ttl) lines.push(`TTL ${request.ttl}`);
    return `${lines.join('\n')};`;
}

/**
 * The Distributed table queries go through.
 *
 * Without a sharding key ClickHouse writes to one shard, so `rand()` is
 * suggested rather than left out - an even spread is nearly always what was
 * wanted, and a wrong key is worse than a random one.
 */
export function distributedTableSql(request: ScaffoldRequest): string | undefined {
    if (!request.cluster) return undefined;
    const key = request.shardingKey ?? 'rand()';
    return [
        `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(request.database)}.${quoteIdentifier(request.table)}${onCluster(request)}`,
        `AS ${quoteIdentifier(request.database)}.${quoteIdentifier(localName(request))}`,
        `ENGINE = Distributed(${quoteIdentifier(request.cluster)}, ${quoteIdentifier(request.database)}, ${quoteIdentifier(localName(request))}, ${key});`,
    ].join('\n');
}

/** A rollup view and the AggregatingMergeTree behind it. */
export function rollupSql(request: ScaffoldRequest): string | undefined {
    const rollup = request.rollup;
    if (!rollup || rollup.groupBy.length === 0) return undefined;

    const target = `${request.table}_rollup`;
    const grouped = rollup.groupBy.map(quoteIdentifier);
    const groupedColumns = rollup.groupBy
        .map(name => {
            const column = request.columns.find(entry => entry.name === name);
            return `    ${quoteIdentifier(name)} ${column?.type ?? 'String'}`;
        })
        .join(',\n');

    const table = [
        `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(request.database)}.${quoteIdentifier(target)}${onCluster(request)}`,
        '(',
        groupedColumns + ',',
        `    ${quoteIdentifier(rollup.aggregate)} AggregateFunction(sum, UInt64)`,
        ')',
        `ENGINE = AggregatingMergeTree()`,
        `ORDER BY (${grouped.join(', ')});`,
    ].join('\n');

    const view = [
        `CREATE MATERIALIZED VIEW IF NOT EXISTS ${quoteIdentifier(request.database)}.${quoteIdentifier(`${request.table}_mv`)}${onCluster(request)}`,
        `TO ${quoteIdentifier(request.database)}.${quoteIdentifier(target)}`,
        'AS SELECT',
        `    ${grouped.join(',\n    ')},`,
        `    sumState(toUInt64(1)) AS ${quoteIdentifier(rollup.aggregate)}`,
        `FROM ${quoteIdentifier(request.database)}.${quoteIdentifier(localName(request))}`,
        `GROUP BY ${grouped.join(', ')};`,
    ].join('\n');

    return `${table}\n\n${view}`;
}

/** The whole scaffold, in the order the statements must be run. */
export function scaffold(request: ScaffoldRequest): string {
    const header = [
        `-- Scaffold for ${request.database}.${request.table}`,
        request.cluster
            ? `-- Cluster ${request.cluster}: a local table per shard, a Distributed table in front.`
            : '-- Single node: one table. Add a cluster to get the Distributed pair.',
        '--',
        '-- Read it before running it. Nothing here is applied for you.',
        '',
    ].join('\n');

    const parts = [localTableSql(request), distributedTableSql(request), rollupSql(request)].filter(
        (part): part is string => part !== undefined
    );

    // The materialized view reads the local table, so it must come last.
    return `${header}\n${parts.join('\n\n')}\n`;
}
