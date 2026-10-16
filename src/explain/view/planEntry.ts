/**
 * Webview bootstrap for the plan view.
 */
import { PlanView } from './planView';
import { PlanHostMessage, PlanTransport, PlanViewMessage } from '../protocol';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const api = acquireVsCodeApi();

const transport: PlanTransport = {
    post(message: PlanViewMessage) {
        api.postMessage(message);
    },
    onMessage(handler: (message: PlanHostMessage) => void) {
        window.addEventListener('message', event => handler(event.data as PlanHostMessage));
    },
};

const root = document.getElementById('root');
if (root) new PlanView(root, transport);
