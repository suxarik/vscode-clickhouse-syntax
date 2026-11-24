/**
 * The query insights page.
 *
 * Built in the host and escaped, like the health page: a query's text and its
 * exception are data from a server, and a log is exactly where hostile text
 * ends up. The only script on the page is the one that posts button clicks.
 */
import { formatBytes } from '../results/format';
import { escapeHtml } from '../health/render';
import { iconSvg } from '../webview/icons';
import { LIMIT } from './fetch';
import { InsightsView, LENSES, Lens, QueryShape, WINDOWS } from './types';

const number = (value: number): string => Math.round(value).toLocaleString('en-US');

export type Tone = 'good' | 'warn' | 'bad' | 'none';

/** A slow tail is what a user feels, so it is the one latency worth colouring. */
export function latencyTone(ms: number): Tone {
    if (ms >= 10_000) return 'bad';
    if (ms >= 1_000) return 'warn';
    return 'good';
}

/** Memory is only worth a colour once it is big enough to matter on a shared server. */
export function memoryTone(bytes: number): Tone {
    if (bytes >= 4 * 1024 ** 3) return 'bad';
    if (bytes >= 1024 ** 3) return 'warn';
    return 'none';
}

/** The column each lens is about, which is where the bar goes. */
const LENS_COLUMN: Record<Lens, 'total' | 'mem' | 'errors' | 'rows'> = {
    time: 'total',
    memory: 'mem',
    errors: 'errors',
    scanned: 'rows',
};

const LENS_ICON: Record<Lens, string> = { time: 'clock', memory: 'memory', errors: 'warning', scanned: 'database' };

/** What a shape counts for in its lens, for sizing the bar. */
function weight(lens: Lens, shape: QueryShape): number {
    if (lens === 'memory') return shape.peakMemory;
    if (lens === 'errors') return shape.errors;
    if (lens === 'scanned') return shape.avgReadRows * shape.runs;
    return shape.totalMs;
}

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
                `title="${escapeHtml(LENSES[lens].description)}">${iconSvg(LENS_ICON[lens])}${escapeHtml(LENSES[lens].label)}</button>`
        )
        .join('');
}

function windowButtons(current: number): string {
    return WINDOWS.map(
        hours =>
            `<button type="button" class="toggle${hours === current ? ' on' : ''}" data-hours="${hours}">${windowLabel(hours)}</button>`
    ).join('');
}

const COLUMNS: Array<{ key: string; label: string; title: string }> = [
    { key: 'rank', label: '#', title: 'Position in this view' },
    { key: 'runs', label: 'Runs', title: 'How many times it ran' },
    { key: 'total', label: 'Total', title: 'Time spent across all runs' },
    { key: 'p95', label: 'p95', title: 'The slowest 5% of runs took at least this long' },
    { key: 'max', label: 'Max', title: 'The slowest single run' },
    { key: 'rows', label: 'Rows / run', title: 'Rows read from storage per run, on average' },
    { key: 'bytes', label: 'Read / run', title: 'Bytes read from storage per run, on average' },
    { key: 'mem', label: 'Peak mem', title: 'The most memory any single run used' },
    { key: 'errors', label: 'Failed', title: 'Runs that raised an exception' },
];

function header(): string {
    const cell = (column: (typeof COLUMNS)[number]): string =>
        `<th class="${column.key === 'rank' ? 'rank' : 'n'}"><button type="button" class="sort" data-sort="${column.key}" ` +
        `title="${escapeHtml(column.title)}">${escapeHtml(column.label)}<span class="arrow"></span></button></th>`;
    return `<tr>${cell(COLUMNS[0])}<th class="q">Statement</th>${COLUMNS.slice(1).map(cell).join('')}<th></th></tr>`;
}

/** Lower-cased text a search is matched against, bounded so a huge statement does not bloat the page. */
function searchText(shape: QueryShape): string {
    return [shape.example.slice(0, 4000), shape.user, shape.tables.join(' '), shape.lastError.slice(0, 500), shape.hash]
        .join(' ')
        .replace(/\s+/g, ' ')
        .toLowerCase();
}

function row(shape: QueryShape, index: number, view: InsightsView, scale: number): string {
    const notes = notesFor(shape);
    const sql = shape.example.replace(/\s+/g, ' ').trim();
    const bar = LENS_COLUMN[view.lens];
    const share = scale > 0 ? Math.max(4, Math.round((weight(view.lens, shape) / scale) * 100)) : 0;
    const cell = (key: string, text: string, tone: Tone = 'none'): string =>
        `<td class="n ${tone}${bar === key ? ' bar' : ''}"${bar === key ? ` style="--w:${share}%"` : ''}><span>${escapeHtml(text)}</span></td>`;

    const chips =
        shape.tables
            .slice(0, 4)
            .map(table => `<span class="chip table">${iconSvg('table')}${escapeHtml(table)}</span>`)
            .join('') +
        (shape.tables.length > 4 ? `<span class="chip">+${shape.tables.length - 4}</span>` : '') +
        (shape.user ? `<span class="chip user">${escapeHtml(shape.user)}</span>` : '');

    const failed =
        shape.errors > 0
            ? `<td class="n bad${bar === 'errors' ? ' bar' : ''}"${bar === 'errors' ? ` style="--w:${share}%"` : ''}>` +
              `<span>${number(shape.errors)} <small>${Math.round((shape.errors / Math.max(shape.runs, 1)) * 100)}%</small></span></td>`
            : '<td class="n none"><span>—</span></td>';

    return (
        `<tr data-i="${index}" data-s="${escapeHtml(searchText(shape))}" data-rank="${index + 1}" data-runs="${shape.runs}" ` +
        `data-total="${shape.totalMs}" data-p95="${shape.p95Ms}" data-max="${shape.maxMs}" ` +
        `data-rows="${shape.avgReadRows}" data-bytes="${shape.avgReadBytes}" data-mem="${shape.peakMemory}" ` +
        `data-errors="${shape.errors}"${shape.errors > 0 ? ' class="failing"' : ''}>` +
        `<td class="rank">${index + 1}</td>` +
        `<td class="q"><div class="sqlbox" title="Click to expand"><code class="sql">${escapeHtml(sql)}</code></div>` +
        `<div class="chips">${chips}</div>` +
        (shape.errors > 0 && shape.lastError
            ? `<p class="error">${iconSvg('error')}${escapeHtml(shape.lastError.split('\n')[0].slice(0, 300))}</p>`
            : '') +
        notes.map(note => `<p class="note">${iconSvg('warning')}${escapeHtml(note)}</p>`).join('') +
        '</td>' +
        `<td class="n none"><span>${number(shape.runs)}</span></td>` +
        cell('total', duration(shape.totalMs)) +
        cell('p95', duration(shape.p95Ms), latencyTone(shape.p95Ms)) +
        cell('max', duration(shape.maxMs)) +
        cell('rows', number(shape.avgReadRows)) +
        cell('bytes', formatBytes(Math.round(shape.avgReadBytes))) +
        cell('mem', formatBytes(shape.peakMemory), memoryTone(shape.peakMemory)) +
        failed +
        `<td class="act"><button type="button" class="icon-btn" data-open="${index}" title="Open this statement in an editor">${iconSvg('open')}</button></td>` +
        '</tr>'
    );
}

function toolbar(): string {
    return (
        '<div class="toolbar">' +
        `<label class="search">${iconSvg('search')}<input id="search" type="search" placeholder="Search statements, tables, users, errors…" ` +
        'autocomplete="off" spellcheck="false"></label>' +
        '<div class="spacer"></div>' +
        '<div class="export"><span class="sub">Export</span>' +
        `<button type="button" data-export="csv" title="Save what is listed, in this order, as CSV">${iconSvg('download')}CSV</button>` +
        `<button type="button" data-export="json" title="Save what is listed, in this order, as JSON">${iconSvg('download')}JSON</button></div>` +
        '</div>'
    );
}

function pager(): string {
    return (
        '<div class="pager">' +
        '<span id="info" class="sub"></span><div class="spacer"></div>' +
        '<label class="sub">Per page <select id="size"><option>10</option><option selected>25</option><option>50</option><option>100</option></select></label>' +
        `<button type="button" id="prev" class="icon-btn" title="Previous page">${iconSvg('chevron-left')}</button>` +
        '<span id="pageno" class="sub"></span>' +
        `<button type="button" id="next" class="icon-btn" title="Next page">${iconSvg('chevron-right')}</button>` +
        '</div>'
    );
}

export function renderInsights(view: InsightsView): string {
    const lens = LENSES[view.lens];
    const parts = [
        `<header><div><h1><span class="title-icon">${iconSvg('pulse')}</span>Query insights ` +
            `<span class="focusname">${escapeHtml(lens.label.toLowerCase())}</span></h1>` +
            `<p class="sub">${escapeHtml(lens.description)}. Statements are grouped by shape, ` +
            'so the same query with different literals is one row. This node only. Everything here only reads.' +
            (view.shapes.length >= LIMIT ? ` Showing the top ${number(LIMIT)}.` : '') +
            '</p></div>' +
            `<button id="refresh" type="button">${iconSvg('refresh')}Refresh</button></header>`,
        `<div class="controls"><div class="segment">${lensButtons(view.lens)}</div><div class="segment">${windowButtons(view.hours)}</div></div>`,
    ];

    if (view.shapes.length === 0) {
        parts.push(
            `<p class="empty">${
                view.lens === 'errors'
                    ? `No failing statements in the last ${windowLabel(view.hours)}.`
                    : `Nothing in system.query_log for the last ${windowLabel(view.hours)}. ` +
                      'If the server is busy, the log may not be enabled or may not have flushed yet.'
            }</p>`
        );
        return parts.join('\n');
    }

    const scale = Math.max(...view.shapes.map(shape => weight(view.lens, shape)));
    parts.push(
        toolbar(),
        '<div class="tablewrap"><table class="insights"><thead>' + header() + '</thead><tbody id="rows">',
        view.shapes.map((shape, index) => row(shape, index, view, scale)).join(''),
        '</tbody></table></div>',
        '<p id="none" class="empty" hidden>No statement matches that search.</p>',
        pager()
    );
    return parts.join('\n');
}

export const INSIGHTS_STYLE = `
:root { --line: var(--vscode-panel-border, rgba(128,128,128,.35)); --good: var(--vscode-testing-iconPassed, #3fb950);
  --warn: var(--vscode-editorWarning-foreground, #cca700); --bad: var(--vscode-editorError-foreground, #f85149);
  --accent: var(--vscode-charts-blue, #3794ff); }
svg { flex: none; vertical-align: -3px; }
header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
header button, .export button { display: inline-flex; align-items: center; gap: 6px; }
.title-icon { display: inline-grid; place-items: center; width: 26px; height: 26px; margin-right: 8px; border-radius: 7px;
  vertical-align: -5px; color: var(--accent); background: color-mix(in srgb, var(--accent) 16%, transparent); }
.focusname { font-size: 14px; font-weight: 500; color: var(--vscode-descriptionForeground); margin-left: 6px; }
.sub, .meta { color: var(--vscode-descriptionForeground); }
.spacer { flex: 1; }

.controls { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 12px; margin: 18px 0 14px; }
.segment { display: inline-flex; border-radius: 6px; overflow: hidden; border: 1px solid var(--line); }
.segment button.toggle { display: inline-flex; align-items: center; gap: 6px; border-radius: 0; padding: 5px 12px;
  color: var(--vscode-foreground); background: var(--vscode-editorWidget-background); }
.segment button.toggle + button.toggle { border-left: 1px solid var(--line); }
.segment button.toggle:hover { background: color-mix(in srgb, var(--accent) 12%, var(--vscode-editorWidget-background)); }
.segment button.toggle.on { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }

.toolbar, .pager { display: flex; align-items: center; gap: 10px; margin: 10px 0; }
.search { display: flex; align-items: center; gap: 8px; flex: 0 1 460px; padding: 0 10px; border-radius: 6px;
  color: var(--vscode-descriptionForeground); background: var(--vscode-input-background, var(--vscode-editorWidget-background));
  border: 1px solid var(--vscode-input-border, var(--line)); }
.search:focus-within { border-color: var(--vscode-focusBorder); }
.search input { flex: 1; min-width: 0; padding: 6px 0; font: inherit; color: var(--vscode-input-foreground, var(--vscode-foreground));
  background: none; border: 0; outline: 0; }
.export { display: flex; align-items: center; gap: 6px; }
button.icon-btn { display: inline-grid; place-items: center; padding: 4px 6px; background: transparent;
  color: var(--vscode-foreground); border: 1px solid var(--line); }
button.icon-btn:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.2)); }
button:disabled { opacity: .4; cursor: default; }
select { font: inherit; padding: 3px 6px; color: var(--vscode-dropdown-foreground, var(--vscode-foreground));
  background: var(--vscode-dropdown-background, var(--vscode-editorWidget-background));
  border: 1px solid var(--vscode-dropdown-border, var(--line)); border-radius: 3px; }

.tablewrap { overflow-x: auto; border-radius: 8px; border: 1px solid var(--line); }
table.insights { min-width: 1100px; }
table.insights th, table.insights td { padding: 8px 12px; vertical-align: top; border-bottom: 1px solid var(--line); }
table.insights thead th { position: sticky; top: 0; background: var(--vscode-editorWidget-background); white-space: nowrap;
  font-size: 11px; text-transform: uppercase; letter-spacing: .05em; vertical-align: middle; }
table.insights tbody tr:last-child td { border-bottom: 0; }
table.insights tbody tr:hover { background: color-mix(in srgb, var(--accent) 7%, transparent); }
table.insights tr.failing td:first-child { box-shadow: inset 3px 0 0 var(--bad); }
th.q, td.q { width: 40%; min-width: 360px; text-align: left; }
th.rank, td.rank { width: 34px; color: var(--vscode-descriptionForeground); text-align: right; padding-right: 4px; }
td.n, th.n { text-align: right; white-space: nowrap; }
td.act { width: 36px; text-align: center; }
button.sort { display: inline-flex; align-items: center; gap: 4px; padding: 0; font: inherit; text-transform: inherit; letter-spacing: inherit;
  color: var(--vscode-descriptionForeground); background: none; border: 0; cursor: pointer; }
button.sort:hover { color: var(--vscode-foreground); background: none; }
button.sort.active { color: var(--vscode-foreground); }
button.sort .arrow::after { content: ''; display: inline-block; width: 0; height: 0; margin-left: 2px; }
button.sort.asc .arrow::after { border: 4px solid transparent; border-bottom-color: currentColor; border-top: 0; }
button.sort.desc .arrow::after { border: 4px solid transparent; border-top-color: currentColor; border-bottom: 0; }

.sqlbox { cursor: pointer; }
.sql { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; word-break: break-word;
  white-space: pre-wrap; line-height: 1.5; }
.sqlbox.open .sql { display: block; -webkit-line-clamp: unset; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.chip { display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px; font-size: 11px; border-radius: 10px;
  color: var(--vscode-descriptionForeground); border: 1px solid var(--line); }
.chip svg { width: 12px; height: 12px; }
.chip.table { color: var(--vscode-charts-green, #89d185); border-color: color-mix(in srgb, var(--vscode-charts-green, #89d185) 40%, transparent); }
.chip.user { color: var(--vscode-charts-purple, #b180d7); border-color: color-mix(in srgb, var(--vscode-charts-purple, #b180d7) 40%, transparent); }
.error, .note { display: flex; gap: 6px; align-items: flex-start; margin: 6px 0 0; font-size: 12px; line-height: 1.45; }
.error { color: var(--bad); font-family: var(--vscode-editor-font-family); }
.note { color: var(--vscode-foreground); padding: 4px 8px; border-radius: 4px;
  background: color-mix(in srgb, var(--warn) 12%, transparent); }
.note svg, .error svg { width: 13px; height: 13px; margin-top: 2px; }
.note svg { color: var(--warn); }

td.n { font-variant-numeric: tabular-nums; }
td.good span { color: var(--good); }
td.warn span { color: var(--warn); font-weight: 600; }
td.bad span { color: var(--bad); font-weight: 600; }
td.bad small { font-weight: 400; opacity: .8; }
td.bar span { display: block; }
td.bar span::after { content: ''; display: block; width: var(--w); height: 3px; margin: 5px 0 0 auto; border-radius: 2px;
  background: var(--accent); opacity: .75; }
td.bar.bad span::after { background: var(--bad); }
.empty { margin: 24px 0; color: var(--vscode-descriptionForeground); }
`;
