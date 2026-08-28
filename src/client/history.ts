/**
 * Query history and after-the-fact profiling.
 *
 * History is local and per workspace: it records what was run and how it went,
 * never the rows that came back. `system.query_log` holds the authoritative
 * counters, so profiling asks the server rather than guessing.
 */
import * as vscode from 'vscode';
import { QueryCapable } from './introspection';

const HISTORY_KEY = 'clickhouse.query.history';
const MAX_ENTRIES = 200;

export interface HistoryEntry {
    sql: string;
    profile: string;
    queryId: string;
    at: number;
    elapsedMs?: number;
    rows?: number;
    error?: string;
}

export class QueryHistory {
    constructor(private readonly context: vscode.ExtensionContext) {}

    entries(): HistoryEntry[] {
        return this.context.workspaceState.get<HistoryEntry[]>(HISTORY_KEY, []);
    }

    async record(entry: HistoryEntry): Promise<void> {
        const trimmed: HistoryEntry = { ...entry, sql: entry.sql.trim() };
        if (!trimmed.sql) return;
        // Newest first, capped, so the store cannot grow without bound.
        const next = [trimmed, ...this.entries()].slice(0, MAX_ENTRIES);
        await this.context.workspaceState.update(HISTORY_KEY, next);
    }

    async clear(): Promise<void> {
        await this.context.workspaceState.update(HISTORY_KEY, []);
    }

    latest(): HistoryEntry | undefined {
        return this.entries()[0];
    }
}

export interface QueryProfile {
    queryId: string;
    durationMs: number;
    readRows: number;
    readBytes: number;
    resultRows: number;
    memoryBytes: number;
    threads: number;
    exception?: string;
}

/**
 * Look a finished query up in `system.query_log`.
 *
 * The log is flushed periodically, so a query that has only just finished may
 * not be there yet; the caller decides whether to wait or report that.
 */
export async function fetchProfile(
    client: QueryCapable,
    queryId: string
): Promise<QueryProfile | undefined> {
    const escaped = queryId.replace(/'/g, "''");
    const result = await client.query(
        `SELECT query_duration_ms,
                read_rows,
                read_bytes,
                result_rows,
                memory_usage,
                length(thread_ids) AS threads,
                exception
         FROM system.query_log
         WHERE query_id = '${escaped}' AND type != 'QueryStart'
         ORDER BY event_time DESC
         LIMIT 1`,
        { readOnly: true, maxExecutionTime: 15 }
    );

    const row = result.rows[0];
    if (!row) return undefined;

    const at = (index: number) => Number(row[index] ?? 0);
    const profile: QueryProfile = {
        queryId,
        durationMs: at(0),
        readRows: at(1),
        readBytes: at(2),
        resultRows: at(3),
        memoryBytes: at(4),
        threads: at(5),
    };
    const exception = String(row[6] ?? '');
    if (exception) profile.exception = exception;
    return profile;
}
