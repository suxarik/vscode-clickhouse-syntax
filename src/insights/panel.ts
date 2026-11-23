/**
 * The query insights panel.
 *
 * Three behaviours reach the host from the page: change the lens or window,
 * refresh, and open a statement as a document. Each arrives as a message whose
 * values are checked against what the page could have sent, since a message is
 * input like any other.
 */
import * as vscode from 'vscode';
import { HEALTH_STYLE, escapeHtml } from '../health/render';
import { INSIGHTS_STYLE, renderInsights } from './render';
import { InsightsView, LENSES, Lens, WINDOWS, Window } from './types';

export type InsightsMessage =
    { type: 'refresh' } | { type: 'set'; lens?: string; hours?: number } | { type: 'open'; index?: number };

export interface InsightsHandlers {
    onRefresh(): void;
    onChange(lens: Lens | undefined, hours: Window | undefined): void;
    onOpen(index: number): void;
}

/** Narrow what the page sent to what it could legitimately have sent. */
export function parseMessage(message: InsightsMessage | undefined): InsightsMessage | undefined {
    if (!message || typeof message !== 'object') return undefined;
    if (message.type === 'refresh') return message;
    if (message.type === 'set') {
        const lens = typeof message.lens === 'string' && message.lens in LENSES ? message.lens : undefined;
        const hours = (WINDOWS as readonly number[]).includes(message.hours as number) ? message.hours : undefined;
        return lens || hours ? { type: 'set', lens, hours } : undefined;
    }
    if (message.type === 'open' && Number.isInteger(message.index) && (message.index as number) >= 0) return message;
    return undefined;
}

export class InsightsPanel implements vscode.Disposable {
    private panel?: vscode.WebviewPanel;

    constructor(private readonly handlers: InsightsHandlers) {}

    show(title: string): void {
        if (this.panel) {
            this.panel.title = title;
            this.panel.reveal(vscode.ViewColumn.Active, false);
            return;
        }
        this.panel = vscode.window.createWebviewPanel(
            'clickhouseInsights',
            title,
            { viewColumn: vscode.ViewColumn.Active },
            { enableScripts: true, retainContextWhenHidden: true }
        );
        this.panel.webview.onDidReceiveMessage((raw: InsightsMessage) => {
            const message = parseMessage(raw);
            if (!message) return;
            if (message.type === 'refresh') this.handlers.onRefresh();
            else if (message.type === 'open') this.handlers.onOpen(message.index as number);
            else this.handlers.onChange(message.lens as Lens | undefined, message.hours as Window | undefined);
        });
        this.panel.onDidDispose(() => {
            this.panel = undefined;
        });
    }

    status(message: string): void {
        this.page(`<p class="sub" style="margin-top:16px">${escapeHtml(message)}</p>`);
    }

    showInsights(view: InsightsView): void {
        this.page(renderInsights(view));
    }

    private page(body: string): void {
        if (!this.panel) return;
        const nonce = Math.random().toString(36).slice(2);
        this.panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>${HEALTH_STYLE}${INSIGHTS_STYLE}</style>
</head>
<body>${body}<script nonce="${nonce}">
const api = acquireVsCodeApi();
document.addEventListener('click', event => {
  const target = event.target instanceof Element ? event.target.closest('button') : null;
  if (!target) return;
  if (target.id === 'refresh') api.postMessage({ type: 'refresh' });
  else if (target.dataset.lens) api.postMessage({ type: 'set', lens: target.dataset.lens });
  else if (target.dataset.hours) api.postMessage({ type: 'set', hours: Number(target.dataset.hours) });
  else if (target.dataset.open !== undefined) api.postMessage({ type: 'open', index: Number(target.dataset.open) });
});
</script></body>
</html>`;
    }

    dispose(): void {
        this.panel?.dispose();
    }
}
