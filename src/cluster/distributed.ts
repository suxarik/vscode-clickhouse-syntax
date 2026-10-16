/**
 * What each shard did for one distributed query.
 *
 * A distributed query runs a subquery on every shard, all sharing the
 * initiator's `initial_query_id`. Their rows are in each node's own
 * `system.query_log`, so reading them means going back out through
 * `clusterAllReplicas`.
 *
 * One subtlety decides whether the numbers mean anything: the initiator's row
 * counts the whole query, not its own shard. Its local contribution is what is
 * left after the remote shards are taken off, and presenting its total as a
 * shard's work would show the initiator doing all of it.
 */
import { QueryResult } from '../client/types';
import { ClusterClient } from './fetch';

export interface ShardWork {
    shard: string;
    host: string;
    isInitiator: boolean;
    durationMs: number;
    readRows: number;
    readBytes: number;
    memoryBytes: number;
}

export interface DistributedProfile {
    shards: ShardWork[];
    totalReadRows: number;
    /** Busiest shard against quietest, by rows read. */
    skew: number;
}

const WORK_SQL =
    "SELECT getMacro('shard') AS shard, getMacro('replica') AS host, " +
    'query_id = {query:String} AS is_initiator, query_duration_ms, read_rows, read_bytes, memory_usage ' +
    'FROM clusterAllReplicas({cluster:Identifier}, system.query_log) ' +
    "WHERE initial_query_id = {query:String} AND type = 'QueryFinish'";

const number = (value: unknown): number => {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
};

/** Turn the raw rows into per-shard work, with the initiator's share derived. */
export function shardWorkFrom(result: QueryResult): DistributedProfile | undefined {
    const index = (name: string): number => result.columns.findIndex(column => column.name === name);
    const rows = result.rows.map(row => ({
        shard: String(row[index('shard')] ?? ''),
        host: String(row[index('host')] ?? ''),
        isInitiator: number(row[index('is_initiator')]) === 1,
        durationMs: number(row[index('query_duration_ms')]),
        readRows: number(row[index('read_rows')]),
        readBytes: number(row[index('read_bytes')]),
        memoryBytes: number(row[index('memory_usage')]),
    }));

    if (rows.length === 0) return undefined;

    const initiator = rows.find(row => row.isInitiator);
    const remote = rows.filter(row => !row.isInitiator);
    // Nothing ran anywhere else, so this was not a distributed query.
    if (!initiator || remote.length === 0) return undefined;

    const remoteRows = remote.reduce((sum, row) => sum + row.readRows, 0);
    const remoteBytes = remote.reduce((sum, row) => sum + row.readBytes, 0);

    const shards: ShardWork[] = [
        {
            ...initiator,
            // What the initiator read for its own shard, rather than in total.
            readRows: Math.max(0, initiator.readRows - remoteRows),
            readBytes: Math.max(0, initiator.readBytes - remoteBytes),
        },
        ...remote,
    ].sort((a, b) => a.shard.localeCompare(b.shard));

    const counts = shards.map(shard => shard.readRows).filter(rows => rows > 0);
    const skew = counts.length > 1 ? Math.max(...counts) / Math.min(...counts) : 1;

    return { shards, totalReadRows: initiator.readRows, skew };
}

export async function fetchDistributedWork(
    client: ClusterClient,
    cluster: string,
    queryId: string
): Promise<DistributedProfile | undefined> {
    try {
        const answer = await client.query(WORK_SQL, {
            readOnly: true,
            maxExecutionTime: 20,
            parameters: { cluster, query: queryId },
            settings: { skip_unavailable_shards: '1' },
        });
        return shardWorkFrom(answer);
    } catch {
        // A query that was never distributed, or a user who cannot read another
        // node's query_log. Either way the single-node plan stands on its own.
        return undefined;
    }
}
