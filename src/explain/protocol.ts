/**
 * Messages between the plan panel and its webview.
 */
import { PlanGraph } from './graph';
import { QuerySummary } from './profile';
import { Finding } from '../advice/types';

export type ImageFormat = 'svg' | 'png' | 'jpg';

/** The mime a runbook cell carries a plan in, so the renderer can draw it. */
export const PLAN_MIME = 'application/vnd.clickhouse.plan+json';

export interface PlanPayload {
    sql: string;
    profile: string;
    /** `EXPLAIN PLAN indexes = 1`, exactly as the server wrote it. */
    explain: string;
    graph: PlanGraph;
    summary?: QuerySummary;
    /** True when the log never flushed, so the graph is empty through no fault of the query. */
    timedOut: boolean;
}

export type PlanHostMessage =
    | { type: 'status'; message: string }
    | { type: 'plan'; payload: PlanPayload }
    /**
     * Sent after the plan, in batches, as the rules find things. `replace`
     * swaps the list for an upgraded one, once a lazy lookup has returned.
     */
    | { type: 'findings'; findings: Finding[]; replace?: boolean }
    | { type: 'error'; message: string };

export type PlanViewMessage =
    | { type: 'ready' }
    | { type: 'export'; format: ImageFormat; data: string };

export interface PlanTransport {
    post(message: PlanViewMessage): void;
    onMessage(handler: (message: PlanHostMessage) => void): void;
}
