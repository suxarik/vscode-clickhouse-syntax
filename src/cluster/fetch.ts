/**
 * Reading a cluster through the one node we are connected to.
 *
 * The extension has a single connection; the other nodes are reachable only as
 * ClickHouse itself reaches them. So the topology comes from `system.clusters`
 * and everything else goes through `clusterAllReplicas`, where a node that is
 * down is simply missing from the answer. That absence is the signal: the
 * `errors_count` in `system.clusters` stays at zero until this node has tried
 * to reach another and failed, so a stopped replica is invisible there.
 */
import { QueryResult } from '../client/types';
import { ClusterHost, ClusterView, DataPlacement, ReplicaHealth } from './types';

export interface ClusterClient {
    query(
        sql: string,
        options?: {
            readOnly?: boolean;
            maxExecutionTime?: number;
            parameters?: Record<string, string>;
            settings?: Record<string, string>;
        }
    ): Promise<QueryResult>;
}

const TOPOLOGY_SQL =
    'SELECT cluster, shard_num, replica_num, host_name, port, is_local, errors_count, ' +
    'slowdowns_count, estimated_recovery_time ' +
    'FROM system.clusters WHERE cluster = {cluster:String} ORDER BY shard_num, replica_num';

const HEALTH_SQL =
    "SELECT getMacro('replica') AS host, database, table, is_readonly, " +
    'ifNull(readonly_duration, 0) AS readonly_duration, is_session_expired, absolute_delay, ' +
    'queue_size, total_replicas, active_replicas, lost_part_count ' +
    'FROM clusterAllReplicas({cluster:Identifier}, system.replicas)';

const PLACEMENT_SQL =
    "SELECT getMacro('shard') AS shard, getMacro('replica') AS host, database, table, " +
    'sum(rows) AS rows, sum(bytes_on_disk) AS bytes, count() AS parts ' +
    'FROM clusterAllReplicas({cluster:Identifier}, system.parts) ' +
    "WHERE active AND database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema') " +
    'GROUP BY shard, host, database, table';

const CLUSTERS_SQL = 'SELECT DISTINCT cluster FROM system.clusters ORDER BY cluster';

/** Column-indexed rows are awkward; everything here wants objects. */
function rows<T>(result: QueryResult): T[] {
    return result.rows.map(row => {
        const object: Record<string, unknown> = {};
        result.columns.forEach((column, index) => {
            object[column.name] = row[index];
        });
        return object as T;
    });
}

const number = (value: unknown): number => {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
};

const flag = (value: unknown): boolean => number(value) === 1;

export async function listClusters(client: ClusterClient): Promise<string[]> {
    const answer = await client.query(CLUSTERS_SQL, { readOnly: true, maxExecutionTime: 10 });
    return answer.rows.map(row => String(row[0] ?? '')).filter(Boolean);
}

export async function fetchCluster(client: ClusterClient, cluster: string): Promise<ClusterView> {
    const parameters = { cluster };

    const topology = rows<Record<string, unknown>>(
        await client.query(TOPOLOGY_SQL, { readOnly: true, maxExecutionTime: 15, parameters })
    );
    const hosts: ClusterHost[] = topology.map(row => ({
        cluster: String(row.cluster ?? cluster),
        shard: number(row.shard_num),
        replica: number(row.replica_num),
        host: String(row.host_name ?? ''),
        port: number(row.port),
        isLocal: flag(row.is_local),
        errors: number(row.errors_count),
        slowdowns: number(row.slowdowns_count),
        estimatedRecoverySeconds: number(row.estimated_recovery_time),
    }));

    let health: ReplicaHealth[] = [];
    let answered: Set<string> | undefined;
    try {
        const raw = rows<Record<string, unknown>>(
            await client.query(HEALTH_SQL, {
                readOnly: true,
                maxExecutionTime: 20,
                parameters,
                // Without this a single stopped node fails the whole query, and
                // the one thing worth seeing is which node stopped.
                settings: { skip_unavailable_shards: '1' },
            })
        );
        health = raw.map(row => ({
            host: String(row.host ?? ''),
            database: String(row.database ?? ''),
            table: String(row.table ?? ''),
            isReadonly: flag(row.is_readonly),
            readonlySeconds: number(row.readonly_duration),
            sessionExpired: flag(row.is_session_expired),
            absoluteDelaySeconds: number(row.absolute_delay),
            queueSize: number(row.queue_size),
            totalReplicas: number(row.total_replicas),
            activeReplicas: number(row.active_replicas),
            lostParts: number(row.lost_part_count),
        }));
        answered = new Set(health.map(entry => entry.host).filter(Boolean));
    } catch {
        // A cluster with no replicated tables answers nothing useful, and a
        // user without rights on system.replicas answers nothing at all. The
        // topology alone is still worth showing.
        answered = undefined;
    }

    // Only claim a host is unreachable when something did answer; otherwise the
    // silence says more about the query than about the cluster.
    const unreachable = answered && answered.size > 0 ? hosts.filter(host => !answered!.has(host.host)) : [];

    let placement: DataPlacement[] = [];
    try {
        placement = rows<Record<string, unknown>>(
            await client.query(PLACEMENT_SQL, {
                readOnly: true,
                maxExecutionTime: 30,
                parameters,
                settings: { skip_unavailable_shards: '1' },
            })
        ).map(row => ({
            shard: String(row.shard ?? ''),
            host: String(row.host ?? ''),
            database: String(row.database ?? ''),
            table: String(row.table ?? ''),
            rows: number(row.rows),
            bytes: number(row.bytes),
            parts: number(row.parts),
        }));
    } catch {
        // Reading every node's parts is the most expensive thing here and the
        // least essential; the rest of the view stands without it.
    }

    return { cluster, hosts, health, unreachable, placement };
}
