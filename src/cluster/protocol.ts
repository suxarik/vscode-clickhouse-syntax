/**
 * Messages between the cluster panel and its webview.
 */
import { Finding } from '../advice/types';
import { ClusterView } from './types';

export interface ClusterPayload {
    view: ClusterView;
    /** `database.table` values seen, so one can be picked out. */
    tables: string[];
    fetchedAt: number;
}

export type ClusterHostMessage =
    | { type: 'status'; message: string }
    | { type: 'cluster'; payload: ClusterPayload }
    | { type: 'findings'; findings: Finding[] }
    | { type: 'error'; message: string };

export type ClusterViewMessage =
    | { type: 'ready' }
    | { type: 'refresh' }
    | { type: 'export'; format: 'svg' | 'png' | 'jpg'; data: string };

export interface ClusterTransport {
    post(message: ClusterViewMessage): void;
    onMessage(handler: (message: ClusterHostMessage) => void): void;
}
