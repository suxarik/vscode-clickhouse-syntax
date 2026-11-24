/**
 * The query insights panel.
 *
 * Four behaviours reach the host from the page: change the lens or window,
 * refresh, open a statement as a document, and export what is listed. Searching,
 * sorting and paging all happen in the page and never reach the host. Each
 * message's values are checked against what the page could have sent, since a
 * message is input like any other.
 */
import * as vscode from 'vscode';
import { HEALTH_STYLE, escapeHtml } from '../health/render';
import { EXPORT_FORMATS, ExportFormat } from './export';
import { LIMIT } from './fetch';
import { INSIGHTS_STYLE, renderInsights } from './render';
import { InsightsView, LENSES, Lens, WINDOWS, Window } from './types';

export type InsightsMessage =
    | { type: 'refresh' }
    | { type: 'set'; lens?: string; hours?: number }
    | { type: 'open'; index?: number }
    | { type: 'export'; format?: string; indices?: unknown };

export interface InsightsHandlers {
    onRefresh(): void;
    onChange(lens: Lens | undefined, hours: Window | undefined): void;
    onOpen(index: number): void;
    onExport(format: ExportFormat, indices: number[]): void;
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
    if (message.type === 'export') {
        const format = (EXPORT_FORMATS as readonly string[]).includes(message.format as string)
            ? message.format
            : undefined;
        // Only whole, in-range positions, once each: the host looks them up in what it fetched.
        const indices = Array.isArray(message.indices)
            ? [...new Set(message.indices.filter((i): i is number => Number.isInteger(i) && i >= 0 && i < LIMIT))]
            : [];
        return format && indices.length > 0 ? { type: 'export', format, indices } : undefined;
    }
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
            else if (message.type === 'export') {
                this.handlers.onExport(message.format as ExportFormat, message.indices as number[]);
            } else this.handlers.onChange(message.lens as Lens | undefined, message.hours as Window | undefined);
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
const tbody = document.getElementById('rows');
const everyRow = tbody ? Array.from(tbody.querySelectorAll('tr[data-i]')) : [];
const search = document.getElementById('search');
const size = document.getElementById('size');
const state = { page: 0, sort: 'rank', dir: 1, shown: everyRow };

function update() {
  if (!tbody) return;
  const pageSize = Number(size.value) || 25;
  const pages = Math.max(1, Math.ceil(state.shown.length / pageSize));
  state.page = Math.min(Math.max(state.page, 0), pages - 1);
  const from = state.page * pageSize;
  const visible = state.shown.slice(from, from + pageSize);
  everyRow.forEach(row => { row.hidden = true; });
  visible.forEach(row => { row.hidden = false; tbody.appendChild(row); });
  const total = everyRow.length;
  document.getElementById('none').hidden = state.shown.length > 0;
  document.getElementById('info').textContent = state.shown.length === 0 ? '' :
    (from + 1) + '–' + (from + visible.length) + ' of ' + state.shown.length +
    (state.shown.length < total ? ' (filtered from ' + total + ')' : '');
  document.getElementById('pageno').textContent = 'Page ' + (state.page + 1) + ' of ' + pages;
  document.getElementById('prev').disabled = state.page === 0;
  document.getElementById('next').disabled = state.page >= pages - 1;
  document.querySelectorAll('button.sort').forEach(button => {
    const on = button.dataset.sort === state.sort;
    button.classList.toggle('active', on);
    button.classList.toggle('asc', on && state.dir === 1);
    button.classList.toggle('desc', on && state.dir === -1);
  });
}

function refilter() {
  const terms = (search.value || '').toLowerCase().split(/\s+/).filter(Boolean);
  const matching = everyRow.filter(row => terms.every(term => row.dataset.s.includes(term)));
  matching.sort((a, b) => state.dir * (Number(a.dataset[state.sort]) - Number(b.dataset[state.sort])));
  state.shown = matching;
  update();
}

if (tbody) {
  search.addEventListener('input', () => { state.page = 0; refilter(); });
  size.addEventListener('change', () => { state.page = 0; update(); });
  document.getElementById('prev').addEventListener('click', () => { state.page--; update(); });
  document.getElementById('next').addEventListener('click', () => { state.page++; update(); });
  refilter();
}

document.addEventListener('click', event => {
  const origin = event.target instanceof Element ? event.target : null;
  if (!origin) return;
  const box = origin.closest('.sqlbox');
  if (box) { box.classList.toggle('open'); return; }
  const target = origin.closest('button');
  if (!target) return;
  if (target.id === 'refresh') api.postMessage({ type: 'refresh' });
  else if (target.dataset.lens) api.postMessage({ type: 'set', lens: target.dataset.lens });
  else if (target.dataset.hours) api.postMessage({ type: 'set', hours: Number(target.dataset.hours) });
  else if (target.dataset.open !== undefined) api.postMessage({ type: 'open', index: Number(target.dataset.open) });
  else if (target.dataset.sort) {
    // First click puts the biggest first, which is what a log is read for; the rank column is the exception.
    const first = target.dataset.sort === 'rank' ? 1 : -1;
    state.dir = state.sort === target.dataset.sort ? -state.dir : first;
    state.sort = target.dataset.sort;
    state.page = 0;
    refilter();
  }
  else if (target.dataset.export) {
    api.postMessage({ type: 'export', format: target.dataset.export, indices: state.shown.map(row => Number(row.dataset.i)) });
  }
});
</script></body>
</html>`;
    }

    dispose(): void {
        this.panel?.dispose();
    }
}
