/**
 * Query history and after-the-fact profiling.
 *
 * History is local and per workspace: it records what was run and how it went,
 * never the rows that came back. `system.query_log` holds the authoritative
 * counters, so profiling asks the server rather than guessing.
 *
 * A query worth keeping can be pinned. Pinned entries are exempt from the cap
 * and from clearing, which is what makes the cap safe to keep small: the
 * history can churn freely without losing the one query you meant to keep.
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
    /** Kept regardless of age, and survives clearing. */
    pinned?: boolean;
    /** What the query is for, set when pinning. */
    label?: string;
}

export class QueryHistory {
    constructor(private readonly context: vscode.ExtensionContext) {}

    /** Newest first, with pinned entries ahead of the rest. */
    entries(): HistoryEntry[] {
        const stored = this.context.workspaceState.get<HistoryEntry[]>(HISTORY_KEY, []);
        return [...stored.filter(e => e.pinned), ...stored.filter(e => !e.pinned)];
    }

    pinned(): HistoryEntry[] {
        return this.entries().filter(e => e.pinned);
    }

    async record(entry: HistoryEntry): Promise<void> {
        const trimmed: HistoryEntry = { ...entry, sql: entry.sql.trim() };
        if (!trimmed.sql) return;
        const stored = this.context.workspaceState.get<HistoryEntry[]>(HISTORY_KEY, []);
        // Only unpinned entries are subject to the cap; a pin is a promise that
        // the query will still be there later.
        const kept = stored.filter(e => e.pinned);
        const recent = [trimmed, ...stored.filter(e => !e.pinned)].slice(0, MAX_ENTRIES);
        await this.context.workspaceState.update(HISTORY_KEY, [...kept, ...recent]);
    }

    /**
     * Pin or unpin the entry with this query id.
     *
     * Returns whether it is pinned afterwards, or `undefined` if there is no
     * such entry.
     */
    async setPinned(queryId: string, pinned: boolean, label?: string): Promise<boolean | undefined> {
        const stored = this.context.workspaceState.get<HistoryEntry[]>(HISTORY_KEY, []);
        const target = stored.find(e => e.queryId === queryId);
        if (!target) return undefined;

        const next = stored.map(entry => {
            if (entry.queryId !== queryId) return entry;
            if (!pinned) {
                const { pinned: _pinned, label: _label, ...rest } = entry;
                return rest;
            }
            return label ? { ...entry, pinned: true, label } : { ...entry, pinned: true };
        });
        await this.context.workspaceState.update(HISTORY_KEY, next);
        return pinned;
    }

    /**
     * Drop the unpinned entries, and report how many pins were kept.
     *
     * Clearing is a housekeeping gesture, not a way to discard work you marked
     * as worth keeping - `clear({ includePinned: true })` is the explicit way
     * to do that.
     */
    async clear(options: { includePinned?: boolean } = {}): Promise<number> {
        const kept = options.includePinned ? [] : this.pinned();
        await this.context.workspaceState.update(HISTORY_KEY, kept);
        return kept.length;
    }

    /** The most recently run query, pinned or not. */
    latest(): HistoryEntry | undefined {
        const stored = this.context.workspaceState.get<HistoryEntry[]>(HISTORY_KEY, []);
        return stored.filter(e => !e.pinned)[0] ?? stored[0];
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
