/**
 * Reading a server's storage health.
 *
 * Each question is its own query and fails on its own. A user without rights on
 * `system.mutations`, or a server too old to have a column, still gets the
 * rest — and the gap is reported by name rather than shown as an empty table,
 * because "nothing stuck" and "could not look" are very different statements.
 */
import { QueryResult } from '../client/types';
import {
    DetachedGroup,
    DiskUsage,
    HealthView,
    PartLimits,
    PartitionParts,
    PendingMutation,
    RunningMerge,
} from './types';

export interface HealthClient {
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

/** ClickHouse's documented defaults, used only when the server cannot be asked. */
export const DEFAULT_LIMITS: PartLimits = { delayAt: 1000, throwAt: 3000 };

/** The most partitions worth drawing; the worst come first, so the rest are the quiet ones. */
const PARTITION_LIMIT = 300;

const SYSTEM_DATABASES = "('system', 'INFORMATION_SCHEMA', 'information_schema')";

function rows<T>(result: QueryResult): T[] {
    return result.rows.map(row => {
        const object: Record<string, unknown> = {};
        result.columns.forEach((column, index) => {
            object[column.name] = row[index];
        });
        return object as T;
    });
}

/** ClickHouse stores a mutation's command wrapped in its own parentheses. */
const unwrap = (command: string): string => {
    const text = command.trim();
    return text.startsWith('(') && text.endsWith(')') ? text.slice(1, -1) : text;
};

const number = (value: unknown): number => {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
};

/** A `database`/`table` filter, as SQL and parameters, or nothing at all. */
function scopeClause(scope: HealthView['scope'], alias = ''): { sql: string; parameters?: Record<string, string> } {
    if (!scope) return { sql: '' };
    const prefix = alias ? `${alias}.` : '';
    return {
        sql: ` AND ${prefix}database = {database:String} AND ${prefix}table = {table:String}`,
        parameters: { database: scope.database, table: scope.table },
    };
}

export async function fetchHealth(client: HealthClient, scope?: HealthView['scope']): Promise<HealthView> {
    const unavailable: string[] = [];
    const filter = scopeClause(scope);

    // One reader for all of them: the read-only flag and a short deadline are
    // not negotiable on a server someone is already worried about.
    const read = async <T>(
        name: string,
        sql: string,
        parameters: Record<string, string> | undefined,
        map: (row: Record<string, unknown>) => T
    ): Promise<T[]> => {
        try {
            const answer = await client.query(sql, { readOnly: true, maxExecutionTime: 20, parameters });
            return rows<Record<string, unknown>>(answer).map(map);
        } catch {
            unavailable.push(name);
            return [];
        }
    };

    const [partitions, merges, mutations, disks, detached, limits] = await Promise.all([
        read<PartitionParts>(
            'parts',
            'SELECT database, table, partition, count() AS parts, sum(rows) AS rows, ' +
                'sum(bytes_on_disk) AS bytes FROM system.parts ' +
                `WHERE active AND database NOT IN ${SYSTEM_DATABASES}${filter.sql} ` +
                `GROUP BY database, table, partition ORDER BY parts DESC LIMIT ${PARTITION_LIMIT}`,
            filter.parameters,
            row => ({
                database: String(row.database ?? ''),
                table: String(row.table ?? ''),
                partition: String(row.partition ?? ''),
                parts: number(row.parts),
                rows: number(row.rows),
                bytes: number(row.bytes),
            })
        ),
        read<RunningMerge>(
            'merges',
            'SELECT database, table, elapsed, progress, num_parts, total_size_bytes_compressed AS bytes, ' +
                `is_mutation FROM system.merges WHERE 1${filter.sql} ORDER BY elapsed DESC`,
            filter.parameters,
            row => ({
                database: String(row.database ?? ''),
                table: String(row.table ?? ''),
                elapsedSeconds: number(row.elapsed),
                progress: number(row.progress),
                numParts: number(row.num_parts),
                bytes: number(row.bytes),
                isMutation: number(row.is_mutation) === 1,
            })
        ),
        read<PendingMutation>(
            'mutations',
            'SELECT database, table, mutation_id, command, ' +
                "dateDiff('second', create_time, now()) AS age, parts_to_do, " +
                `latest_fail_reason FROM system.mutations WHERE NOT is_done${filter.sql} ORDER BY create_time`,
            filter.parameters,
            row => ({
                database: String(row.database ?? ''),
                table: String(row.table ?? ''),
                id: String(row.mutation_id ?? ''),
                command: unwrap(String(row.command ?? '')),
                ageSeconds: number(row.age),
                partsToDo: number(row.parts_to_do),
                failReason: String(row.latest_fail_reason ?? ''),
            })
        ),
        // Disks belong to the server, not to a table, so a scope does not narrow them.
        read<DiskUsage>('disks', 'SELECT name, free_space, total_space FROM system.disks', undefined, row => ({
            name: String(row.name ?? ''),
            freeBytes: number(row.free_space),
            totalBytes: number(row.total_space),
        })),
        read<DetachedGroup>(
            'detached parts',
            "SELECT database, table, ifNull(reason, '') AS reason, count() AS parts " +
                `FROM system.detached_parts WHERE 1${filter.sql} GROUP BY database, table, reason ` +
                'ORDER BY parts DESC LIMIT 100',
            filter.parameters,
            row => ({
                database: String(row.database ?? ''),
                table: String(row.table ?? ''),
                reason: String(row.reason ?? ''),
                parts: number(row.parts),
            })
        ),
        readLimits(client),
    ]);

    return {
        scope,
        partitions,
        merges,
        mutations,
        disks: disks.filter(disk => disk.totalBytes > 0),
        detached,
        limits: limits ?? DEFAULT_LIMITS,
        limitsFromServer: limits !== undefined,
        unavailable: unavailable.sort(),
    };
}

/**
 * The thresholds this server actually uses.
 *
 * They are MergeTree settings with a server-wide default, and a deployment may
 * have raised them. A table can override them too, which this does not see; the
 * panel says where the numbers came from so that limit is not mistaken for the
 * whole truth.
 */
async function readLimits(client: HealthClient): Promise<PartLimits | undefined> {
    try {
        const answer = await client.query(
            "SELECT name, value FROM system.merge_tree_settings WHERE name IN ('parts_to_delay_insert', 'parts_to_throw_insert')",
            { readOnly: true, maxExecutionTime: 10 }
        );
        const found = new Map(answer.rows.map(row => [String(row[0]), Number(row[1])]));
        const delayAt = found.get('parts_to_delay_insert');
        const throwAt = found.get('parts_to_throw_insert');
        if (!delayAt || !throwAt || !Number.isFinite(delayAt) || !Number.isFinite(throwAt)) return undefined;
        return { delayAt, throwAt };
    } catch {
        return undefined;
    }
}
