/**
 * Running a query for its profile, and collecting what the server recorded.
 *
 * The query runs with its results discarded. A plan view answers where the time
 * went, which Run already answers for what came back — and fetching a million
 * production rows to draw a graph of them would be indefensible.
 *
 * `system.processors_profile_log` is written on a timer, so the rows are not
 * there the instant the query ends. `SYSTEM FLUSH LOGS` forces it, but that is
 * a write, so on a read-only profile the only option is to wait and look again.
 */
import { parse } from '../parser/parser';
import { QueryResult } from '../client/types';
import { ProcessorRow } from './graph';

export interface ProfileClient {
    query(
        sql: string,
        options?: {
            readOnly?: boolean;
            queryId?: string;
            maxExecutionTime?: number;
            parameters?: Record<string, string>;
            settings?: Record<string, string>;
        }
    ): Promise<QueryResult>;
}

/** Wall-clock totals, which processor CPU time cannot give. */
export interface QuerySummary {
    query_duration_ms: number;
    read_rows: number;
    read_bytes: number;
    memory_usage: number;
    threads: number;
}

export interface CollectedProfile {
    rows: ProcessorRow[];
    summary?: QuerySummary;
    /** True when the log never flushed in time; the graph will be empty. */
    timedOut: boolean;
}

export interface CollectOptions {
    queryId: string;
    /** The profile permits writes, so the log can be flushed instead of waited for. */
    canFlushLogs: boolean;
    maxExecutionTime?: number;
    timeoutMs?: number;
    pollIntervalMs?: number;
    /** Injected by tests so they do not wait. */
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
}

const PROFILE_FIELDS = [
    'id', 'parent_ids', 'plan_step', 'plan_step_name', 'plan_step_description', 'plan_group',
    'step_uniq_id', 'name', 'elapsed_us', 'input_wait_elapsed_us', 'output_wait_elapsed_us',
    'input_rows', 'input_bytes', 'output_rows', 'output_bytes',
];

const PROFILE_SQL =
    `SELECT ${PROFILE_FIELDS.join(', ')} ` +
    'FROM system.processors_profile_log WHERE query_id = {qid:String} ORDER BY id';

const SUMMARY_SQL =
    'SELECT query_duration_ms, read_rows, read_bytes, memory_usage, length(thread_ids) AS threads ' +
    "FROM system.query_log WHERE query_id = {qid:String} AND type != 'QueryStart' " +
    'ORDER BY event_time DESC LIMIT 1';

/**
 * The statement to run for a profile: the same query, returning nothing.
 *
 * A FORMAT the author already wrote has to go, since a query carries only one.
 * Finding it through the parse tree rather than a regular expression is what
 * keeps `SELECT 'FORMAT JSON'` from being mistaken for one.
 */
export function analyzeSql(sql: string): string {
    const trimmed = sql.trim().replace(/;\s*$/, '');
    const statement = parse(trimmed).program.statements[0];

    let body = trimmed;
    if (statement && statement.kind === 'SelectStatement' && statement.format) {
        const keyword = trimmed.toUpperCase().lastIndexOf('FORMAT', statement.format.start);
        if (keyword >= 0) body = trimmed.slice(0, keyword).trimEnd();
    }
    return `${body}\nFORMAT Null`;
}

/** Column-indexed rows are awkward to read; the graph wants objects. */
function toObjects<T>(result: QueryResult): T[] {
    return result.rows.map(row => {
        const object: Record<string, unknown> = {};
        result.columns.forEach((column, index) => {
            object[column.name] = row[index];
        });
        return object as T;
    });
}

const defaultSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export async function collectProfile(
    client: ProfileClient,
    sql: string,
    options: CollectOptions
): Promise<CollectedProfile> {
    const sleep = options.sleep ?? defaultSleep;
    const now = options.now ?? Date.now;
    const timeoutMs = options.timeoutMs ?? 12_000;
    const pollIntervalMs = options.pollIntervalMs ?? 600;

    await client.query(analyzeSql(sql), {
        readOnly: true,
        queryId: options.queryId,
        maxExecutionTime: options.maxExecutionTime,
        settings: { log_processors_profiles: '1' },
    });

    if (options.canFlushLogs) {
        try {
            await client.query('SYSTEM FLUSH LOGS');
        } catch {
            // Not permitted after all. Waiting still works.
        }
    }

    const deadline = now() + timeoutMs;
    let rows: ProcessorRow[] = [];
    let timedOut = false;

    for (;;) {
        const answer = await client.query(PROFILE_SQL, {
            readOnly: true,
            parameters: { qid: options.queryId },
        });
        rows = toObjects<ProcessorRow>(answer);
        if (rows.length > 0) break;

        if (now() >= deadline) {
            timedOut = true;
            break;
        }
        await sleep(pollIntervalMs);
    }

    let summary: QuerySummary | undefined;
    try {
        const answer = await client.query(SUMMARY_SQL, {
            readOnly: true,
            parameters: { qid: options.queryId },
        });
        const raw = toObjects<Record<string, unknown>>(answer)[0];
        // Quoted 64-bit integers again: the panel does arithmetic on these.
        summary = raw && {
            query_duration_ms: Number(raw.query_duration_ms ?? 0),
            read_rows: Number(raw.read_rows ?? 0),
            read_bytes: Number(raw.read_bytes ?? 0),
            memory_usage: Number(raw.memory_usage ?? 0),
            threads: Number(raw.threads ?? 0),
        };
    } catch {
        // The totals are a nicety; the graph stands without them.
    }

    return { rows, summary, timedOut };
}
