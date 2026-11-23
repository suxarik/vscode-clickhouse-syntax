/**
 * The storage health panel.
 *
 * The host builds the page and the page has one behaviour, Refresh, so there is
 * no message protocol to speak of. The script is the only one allowed to run
 * and carries a nonce; nothing from the server is ever inside it.
 */
import * as vscode from 'vscode';
import { Finding } from '../advice/types';
import { HEALTH_STYLE, escapeHtml, renderHealth } from './render';
import { HealthView } from './types';

export class HealthPanel implements vscode.Disposable {
    private panel?: vscode.WebviewPanel;

    constructor(private readonly onRefresh: () => void) {}

    show(title: string): void {
        if (this.panel) {
            this.panel.title = title;
            this.panel.reveal(vscode.ViewColumn.Active, false);
            return;
        }
        this.panel = vscode.window.createWebviewPanel(
            'clickhouseHealth',
            title,
            { viewColumn: vscode.ViewColumn.Active },
            { enableScripts: true, retainContextWhenHidden: true }
        );
        this.panel.webview.onDidReceiveMessage((message: { type?: string }) => {
            if (message?.type === 'refresh') this.onRefresh();
        });
        this.panel.onDidDispose(() => {
            this.panel = undefined;
        });
    }

    /** Replace the page with a one-line status, such as "Reading…" or an error. */
    status(message: string): void {
        this.page(`<p class="note" style="margin-top:16px">${escapeHtml(message)}</p>`);
    }

    showHealth(view: HealthView, findings: Finding[]): void {
        this.page(renderHealth(view, findings, Date.now()));
    }

    private page(body: string): void {
        if (!this.panel) return;
        const webview = this.panel.webview;
        const nonce = Math.random().toString(36).slice(2);
        webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>${HEALTH_STYLE}</style>
</head>
<body>${body}<script nonce="${nonce}">
const api = acquireVsCodeApi();
const button = document.getElementById('refresh');
if (button) button.addEventListener('click', () => api.postMessage({ type: 'refresh' }));
</script></body>
</html>`;
    }

    dispose(): void {
        this.panel?.dispose();
    }
}
