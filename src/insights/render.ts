/**
 * The query insights page.
 *
 * Built in the host and escaped, like the health page: a query's text and its
 * exception are data from a server, and a log is exactly where hostile text
 * ends up. The only script on the page is the one that posts button clicks.
 */
import { formatBytes } from '../results/format';
import { escapeHtml } from '../health/render';
import { InsightsView, LENSES, Lens, QueryShape, WINDOWS } from './types';

const number = (value: number): string => Math.round(value).toLocaleString('en-US');

function duration(ms: number): string {
    if (ms < 1000) return `${Math.round(ms)} ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
    if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)} min`;
    return `${(ms / 3_600_000).toFixed(1)} h`;
}

function windowLabel(hours: number): string {
    return hours < 24 ? `${hours}h` : `${hours / 24}d`;
}

/** What is worth saying about one statement, each with the number behind it. */
export function notesFor(shape: QueryShape): string[] {
    const notes: string[] = [];

    if (
        shape.avgReadRows >= 1_000_000 &&
        shape.avgResultRows >= 0 &&
        shape.avgReadRows / Math.max(shape.avgResultRows, 1) >= 1000
    ) {
        notes.push(
            `Reads ${number(shape.avgReadRows)} rows per run to return ${number(shape.avgResultRows)}. ` +
                "The filter probably does not line up with the table's sorting key, so most of that is thrown away."
        );
    }

    const average = shape.runs > 0 ? shape.totalMs / shape.runs : 0;
    if (shape.runs >= 20 && average > 0 && shape.p95Ms >= average * 5) {
        notes.push(
            `Uneven: the slowest 5% take ${duration(shape.p95Ms)} or more against an average of ${duration(average)}. ` +
                'Look at what differs between the fast and the slow runs — a parameter, a cold cache, a busy moment.'
        );
    }

    if (shape.errors > 0) {
        const share = Math.round((shape.errors / shape.runs) * 100);
        notes.push(
            `Failed ${number(shape.errors)} of ${number(shape.runs)} runs (${share}%)` +
                (shape.lastErrorCode ? `, code ${shape.lastErrorCode}` : '') +
                '.'
        );
    }
    return notes;
}

function lensButtons(current: Lens): string {
    return (Object.keys(LENSES) as Lens[])
        .map(
            lens =>
                `<button type="button" class="toggle${lens === current ? ' on' : ''}" data-lens="${lens}" ` +
                `title="${escapeHtml(LENSES[lens].description)}">${escapeHtml(LENSES[lens].label)}</button>`
        )
        .join('');
}

function windowButtons(current: number): string {
    return WINDOWS.map(
        hours =>
            `<button type="button" class="toggle${hours === current ? ' on' : ''}" data-hours="${hours}">${windowLabel(hours)}</button>`
    ).join('');
}

function row(shape: QueryShape, index: number): string {
    const notes = notesFor(shape);
    const preview = shape.example.replace(/\s+/g, ' ').trim();
    return (
        '<article class="shape">' +
        `<div class="top"><code class="sql">${escapeHtml(preview.length > 240 ? `${preview.slice(0, 239)}…` : preview)}</code>` +
        `<button type="button" data-open="${index}">Open</button></div>` +
        '<div class="figures">' +
        `<span><b>${number(shape.runs)}</b> runs</span>` +
        `<span><b>${escapeHtml(duration(shape.totalMs))}</b> total</span>` +
        `<span><b>${escapeHtml(duration(shape.p95Ms))}</b> p95</span>` +
        `<span><b>${escapeHtml(duration(shape.maxMs))}</b> max</span>` +
        `<span><b>${number(shape.avgReadRows)}</b> rows read / run</span>` +
        `<span><b>${escapeHtml(formatBytes(shape.avgReadBytes))}</b> read / run</span>` +
        `<span><b>${escapeHtml(formatBytes(shape.peakMemory))}</b> peak memory</span>` +
        '</div>' +
        (shape.tables.length > 0
            ? `<p class="meta">${escapeHtml(shape.tables.slice(0, 6).join(', '))}${shape.tables.length > 6 ? ', …' : ''} · ${escapeHtml(shape.user)}</p>`
            : `<p class="meta">${escapeHtml(shape.user)}</p>`) +
        (shape.errors > 0 && shape.lastError
            ? `<p class="error">${escapeHtml(shape.lastError.split('\n')[0].slice(0, 300))}</p>`
            : '') +
        notes.map(note => `<p class="note">${escapeHtml(note)}</p>`).join('') +
        '</article>'
    );
}

export function renderInsights(view: InsightsView): string {
    const parts = [
        `<header><div><h1>Query insights — ${escapeHtml(LENSES[view.lens].label.toLowerCase())}</h1>` +
            `<p class="sub">${escapeHtml(LENSES[view.lens].description)}. Statements are grouped by shape, ` +
            'so the same query with different literals is one row. This node only. Everything here only reads.</p></div>' +
            '<button id="refresh" type="button">Refresh</button></header>',
        `<div class="controls"><div>${lensButtons(view.lens)}</div><div>${windowButtons(view.hours)}</div></div>`,
    ];

    parts.push(
        view.shapes.length === 0
            ? `<p class="empty">${
                  view.lens === 'errors'
                      ? `No failing statements in the last ${windowLabel(view.hours)}.`
                      : `Nothing in system.query_log for the last ${windowLabel(view.hours)}. ` +
                        'If the server is busy, the log may not be enabled or may not have flushed yet.'
              }</p>`
            : view.shapes.map(row).join('')
    );
    return parts.join('\n');
}

export const INSIGHTS_STYLE = `
header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
.sub, .meta { color: var(--vscode-descriptionForeground); }
.controls { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 12px; margin: 16px 0; }
.controls > div { display: flex; gap: 4px; }
button.toggle { color: var(--vscode-foreground); background: var(--vscode-editorWidget-background);
  border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35)); }
button.toggle.on { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border-color: transparent; }
.shape { padding: 10px 12px; margin-bottom: 8px; border-radius: 3px; background: var(--vscode-editorWidget-background); }
.top { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
.sql { white-space: pre-wrap; word-break: break-word; flex: 1; }
.figures { display: flex; flex-wrap: wrap; gap: 4px 18px; margin-top: 8px; font-variant-numeric: tabular-nums;
  color: var(--vscode-descriptionForeground); }
.figures b { color: var(--vscode-foreground); font-weight: 600; }
.meta { margin: 6px 0 0; }
.error { margin: 6px 0 0; color: var(--vscode-editorError-foreground, #f85149); font-family: var(--vscode-editor-font-family); font-size: 12px; }
.note { margin: 6px 0 0; padding-left: 8px; border-left: 3px solid var(--vscode-editorWarning-foreground, #cca700); }
.empty { margin-top: 24px; color: var(--vscode-descriptionForeground); }
`;
