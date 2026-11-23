/**
 * The lineage panel: refresh, and look from another table.
 *
 * The table a click names is checked against what was drawn before it is
 * believed, since a message from a page is input like any other.
 */
import * as vscode from 'vscode';
import { HEALTH_STYLE, escapeHtml } from '../health/render';
import { LINEAGE_STYLE } from './render';

export class LineagePanel implements vscode.Disposable {
    private panel?: vscode.WebviewPanel;
    private known = new Set<string>();

    constructor(
        private readonly onRefresh: () => void,
        private readonly onFocus: (table: string) => void
    ) {}

    show(title: string): void {
        if (this.panel) {
            this.panel.title = title;
            this.panel.reveal(vscode.ViewColumn.Active, false);
            return;
        }
        this.panel = vscode.window.createWebviewPanel(
            'clickhouseLineage',
            title,
            { viewColumn: vscode.ViewColumn.Active },
            { enableScripts: true, retainContextWhenHidden: true }
        );
        this.panel.webview.onDidReceiveMessage((message: { type?: string; table?: unknown }) => {
            if (message?.type === 'refresh') this.onRefresh();
            else if (message?.type === 'focus' && typeof message.table === 'string' && this.known.has(message.table)) {
                this.onFocus(message.table);
            }
        });
        this.panel.onDidDispose(() => {
            this.panel = undefined;
        });
    }

    status(message: string): void {
        this.page(`<p class="sub" style="margin-top:16px">${escapeHtml(message)}</p>`);
    }

    /** `known` is every name that was drawn as a link. */
    showLineage(html: string, known: Iterable<string>): void {
        this.known = new Set(known);
        this.page(html);
    }

    private page(body: string): void {
        if (!this.panel) return;
        const nonce = Math.random().toString(36).slice(2);
        this.panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>${HEALTH_STYLE}${LINEAGE_STYLE}</style>
</head>
<body>${body}<script nonce="${nonce}">
const api = acquireVsCodeApi();
document.addEventListener('click', event => {
  const target = event.target instanceof Element ? event.target.closest('button') : null;
  if (!target) return;
  if (target.id === 'refresh') api.postMessage({ type: 'refresh' });
  else if (target.dataset.focus) api.postMessage({ type: 'focus', table: target.dataset.focus });
});
</script></body>
</html>`;
    }

    dispose(): void {
        this.panel?.dispose();
    }
}
