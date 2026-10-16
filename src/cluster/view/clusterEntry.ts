/**
 * Webview bootstrap for the cluster map.
 */
import { ClusterView } from './clusterView';
import { ClusterHostMessage, ClusterTransport, ClusterViewMessage } from '../protocol';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const api = acquireVsCodeApi();

const transport: ClusterTransport = {
    post(message: ClusterViewMessage) {
        api.postMessage(message);
    },
    onMessage(handler: (message: ClusterHostMessage) => void) {
        window.addEventListener('message', event => handler(event.data as ClusterHostMessage));
    },
};

const root = document.getElementById('root');
if (root) new ClusterView(root, transport);
