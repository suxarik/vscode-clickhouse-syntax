/**
 * What a server has actually been asked, from `system.query_log`.
 *
 * Queries are grouped by `normalized_query_hash`, which is the query with its
 * literals stripped: a dashboard that issues the same statement ten thousand
 * times with a different date is one row here, which is the only way its cost
 * is visible at all.
 */

export type Lens = 'time' | 'memory' | 'errors' | 'scanned';

export const LENSES: Record<Lens, { label: string; description: string }> = {
    time: { label: 'Slowest overall', description: 'Total time spent, which is runs times duration' },
    memory: { label: 'Most memory', description: 'The largest peak memory any single run used' },
    errors: { label: 'Failing', description: 'Statements that raised an exception' },
    scanned: { label: 'Most rows read', description: 'Total rows read from storage' },
};

/** Windows offered, in hours. */
export const WINDOWS = [1, 6, 24, 168] as const;
export type Window = (typeof WINDOWS)[number];

export interface QueryShape {
    hash: string;
    /** A real example, literals and all, so it can be opened and run. */
    example: string;
    user: string;
    runs: number;
    totalMs: number;
    p95Ms: number;
    maxMs: number;
    /** Averages per run, which is what a person compares against a result. */
    avgReadRows: number;
    avgReadBytes: number;
    avgResultRows: number;
    peakMemory: number;
    errors: number;
    lastError: string;
    lastErrorCode: number;
    tables: string[];
}

export interface InsightsView {
    lens: Lens;
    hours: Window;
    shapes: QueryShape[];
}
