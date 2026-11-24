/**
 * Reading the query log.
 *
 * The ordering comes from a fixed table, never from the caller, because it goes
 * into the SQL text; the window goes in as a parameter. Queries against the
 * system tables themselves are left out when they are all that a statement
 * touches, or the first thing the log reports is this panel reading it.
 */
import { QueryResult } from '../client/types';
import { InsightsView, Lens, QueryShape, Window } from './types';

export interface InsightsClient {
    query(
        sql: string,
        options?: { readOnly?: boolean; maxExecutionTime?: number; parameters?: Record<string, string> }
    ): Promise<QueryResult>;
}

const ORDER: Record<Lens, string> = {
    time: 'total_ms DESC',
    memory: 'peak_memory DESC',
    errors: 'errors DESC, runs DESC',
    scanned: 'read_rows_total DESC',
};

/**
 * How many statements one read brings back. The page filters and pages these in
 * place, so this is what search can see; a busy server has far more shapes than
 * anyone reads, and the lens puts the ones that matter first.
 */
export const LIMIT = 500;

/** Longest example kept, so a statement carrying a megabyte of VALUES cannot bloat the page. */
const EXAMPLE_CHARS = 20_000;

export function insightsSql(lens: Lens): string {
    // For "failing" the rows that matter are the failures, so the extra filter
    // is on errors; for the others a failed run's duration is still real time.
    const having = lens === 'errors' ? 'HAVING errors > 0 ' : '';
    return (
        'SELECT toString(normalized_query_hash) AS hash, ' +
        `left(argMax(query, query_duration_ms), ${EXAMPLE_CHARS}) AS example, ` +
        'any(user) AS user, ' +
        'count() AS runs, ' +
        'sum(query_duration_ms) AS total_ms, ' +
        'quantile(0.95)(query_duration_ms) AS p95_ms, ' +
        'max(query_duration_ms) AS max_ms, ' +
        'sum(read_rows) AS read_rows_total, ' +
        'avg(read_rows) AS avg_read_rows, ' +
        'avg(read_bytes) AS avg_read_bytes, ' +
        'avg(result_rows) AS avg_result_rows, ' +
        'max(memory_usage) AS peak_memory, ' +
        "countIf(type IN ('ExceptionBeforeStart', 'ExceptionWhileProcessing')) AS errors, " +
        "argMaxIf(exception, event_time, exception != '') AS last_error, " +
        'maxIf(exception_code, exception_code != 0) AS last_error_code, ' +
        'groupUniqArrayArray(tables) AS touched ' +
        'FROM system.query_log ' +
        "WHERE event_time >= now() - toIntervalHour({hours:UInt32}) AND type != 'QueryStart' " +
        'AND is_initial_query ' +
        "AND NOT (notEmpty(tables) AND arrayAll(t -> startsWith(t, 'system.'), tables)) " +
        `GROUP BY normalized_query_hash ${having}ORDER BY ${ORDER[lens]} LIMIT ${LIMIT}`
    );
}

const number = (value: unknown): number => {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
};

export function toShapes(result: QueryResult): QueryShape[] {
    return result.rows.map(row => {
        const o: Record<string, unknown> = {};
        result.columns.forEach((column, index) => (o[column.name] = row[index]));
        return {
            hash: String(o.hash ?? ''),
            example: String(o.example ?? ''),
            user: String(o.user ?? ''),
            runs: number(o.runs),
            totalMs: number(o.total_ms),
            p95Ms: number(o.p95_ms),
            maxMs: number(o.max_ms),
            avgReadRows: number(o.avg_read_rows),
            avgReadBytes: number(o.avg_read_bytes),
            avgResultRows: number(o.avg_result_rows),
            peakMemory: number(o.peak_memory),
            errors: number(o.errors),
            lastError: String(o.last_error ?? ''),
            lastErrorCode: number(o.last_error_code),
            tables: Array.isArray(o.touched) ? o.touched.map(String) : [],
        };
    });
}

export async function fetchInsights(client: InsightsClient, lens: Lens, hours: Window): Promise<InsightsView> {
    const result = await client.query(insightsSql(lens), {
        readOnly: true,
        maxExecutionTime: 30,
        parameters: { hours: String(hours) },
    });
    return { lens, hours, shapes: toShapes(result) };
}
