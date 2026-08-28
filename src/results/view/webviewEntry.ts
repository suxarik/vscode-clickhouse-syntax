/**
 * Webview bootstrap: wires the grid to the VS Code webview messaging API.
 *
 * The notebook renderer entry point in 2.1 replaces only this file.
 */
import { GridView } from './gridView';
import { Transport } from './transport';
import { HostMessage, ViewMessage } from '../protocol';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const api = acquireVsCodeApi();

const transport: Transport = {
    post(message: ViewMessage) {
        api.postMessage(message);
    },
    onMessage(handler: (message: HostMessage) => void) {
        window.addEventListener('message', event => handler(event.data as HostMessage));
    },
};

const root = document.getElementById('root');
if (root) new GridView(root, transport);
