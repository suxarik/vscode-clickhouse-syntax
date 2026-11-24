/**
 * The health panel's page.
 *
 * Plain HTML built here, not in a webview bundle: there is nothing to draw
 * that a table and a few bars cannot say. The only script on the page filters
 * and pages the partition list and posts Refresh; nothing from the server is
 * ever inside it. Every value from the server is escaped on the way in — a
 * table name or a mutation's error text is data, never markup.
 */
import { Finding, Importance } from '../advice/types';
import { formatBytes } from '../results/format';
import { iconSvg } from '../webview/icons';
import { HealthView, PartLimits } from './types';

export function escapeHtml(value: unknown): string {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

const number = (value: number): string => value.toLocaleString('en-US');

function duration(seconds: number): string {
    if (seconds < 60) return `${Math.round(seconds)}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    if (seconds < 86_400) return `${(seconds / 3600).toFixed(1)}h`;
    return `${(seconds / 86_400).toFixed(1)}d`;
}

export type Tone = 'good' | 'warn' | 'bad' | 'none';

/** How close a partition is to the limits that slow and then stop inserts. */
export function partsTone(parts: number, limits: PartLimits): Tone {
    if (parts >= limits.throwAt * 0.8) return 'bad';
    if (parts >= limits.delayAt) return 'warn';
    return 'good';
}

/** A disk is a problem by how little is left, not by how much is used. */
export function diskTone(freePercent: number): Tone {
    if (freePercent < 10) return 'bad';
    if (freePercent < 20) return 'warn';
    return 'good';
}

const SEVERITY_ICON: Record<Importance, string> = { high: 'error', medium: 'warning', low: 'info' };

export function findingCard(finding: Finding): string {
    return (
        `<article class="finding ${finding.importance}">` +
        `<span class="fi">${iconSvg(SEVERITY_ICON[finding.importance])}</span>` +
        '<div class="fbody">' +
        `<div class="fhead"><h3>${escapeHtml(finding.title)}</h3>` +
        `<span class="badge">${escapeHtml(finding.importance)}</span></div>` +
        `<p class="evidence">${escapeHtml(finding.evidence)}</p>` +
        (finding.suggestion ? `<p class="suggest">${escapeHtml(finding.suggestion)}</p>` : '') +
        '</div></article>'
    );
}

function qualified(database: string, name: string): string {
    return (
        `<span class="names"><span class="tname">${escapeHtml(name)}</span>` +
        `<span class="db">${escapeHtml(database)}</span></span>`
    );
}

/** A thin bar, filled to `percent`, in the tone of what it measures. */
function bar(percent: number, tone: Tone, marker?: number): string {
    const fill = Math.min(100, Math.max(percent > 0 ? 2 : 0, percent));
    return (
        `<span class="meter ${tone}"><span class="fill" style="--w:${fill.toFixed(1)}%"></span>` +
        (marker !== undefined ? `<span class="mark" style="--m:${Math.min(100, marker).toFixed(1)}%"></span>` : '') +
        '</span>'
    );
}

function table(
    head: Array<{ label: string; numeric?: boolean }>,
    body: string[],
    attributes = '',
    bodyId?: string
): string {
    return (
        `<div class="tablewrap"><table class="grid"${attributes}><thead><tr>` +
        head.map(column => `<th${column.numeric ? ' class="n"' : ''}>${escapeHtml(column.label)}</th>`).join('') +
        `</tr></thead><tbody${bodyId ? ` id="${bodyId}"` : ''}>${body.join('')}</tbody></table></div>`
    );
}

function section(icon: string, title: string, content: string, note?: string): string {
    return (
        `<section><h2>${iconSvg(icon)}${escapeHtml(title)}</h2>` +
        `${note ? `<p class="note">${escapeHtml(note)}</p>` : ''}${content}</section>`
    );
}

interface Tile {
    icon: string;
    tone: Tone;
    label: string;
    value: string;
    detail: string;
}

function tileHtml(tile: Tile): string {
    return (
        `<div class="tile ${tile.tone}"><span class="ti">${iconSvg(tile.icon)}</span>` +
        `<div><div class="tl">${escapeHtml(tile.label)}</div>` +
        `<div class="tv">${escapeHtml(tile.value)}</div>` +
        `<div class="td">${escapeHtml(tile.detail)}</div></div></div>`
    );
}

/** One glance: is anything wrong, and which of the five things it is. */
function tiles(view: HealthView, findings: Finding[]): Tile[] {
    const readable = (name: string): boolean => !view.unavailable.includes(name);
    const result: Tile[] = [];

    const high = findings.filter(finding => finding.importance === 'high').length;
    const other = findings.length - high;
    if (view.unavailable.length >= 5) {
        result.push({
            icon: 'warning',
            tone: 'warn',
            label: 'Status',
            value: 'Unknown',
            detail: 'Nothing could be read',
        });
    } else if (findings.length === 0) {
        result.push({
            icon: 'check',
            tone: 'good',
            label: 'Status',
            value: 'Healthy',
            detail: view.unavailable.length > 0 ? 'For what could be read' : 'Nothing to report',
        });
    } else {
        result.push({
            icon: high > 0 ? 'error' : 'warning',
            tone: high > 0 ? 'bad' : 'warn',
            label: 'Status',
            value: `${findings.length} to look at`,
            detail: [high > 0 ? `${high} high` : '', other > 0 ? `${other} other` : ''].filter(Boolean).join(' · '),
        });
    }

    if (readable('parts') && view.partitions.length > 0) {
        const worst = view.partitions.reduce((a, b) => (b.parts > a.parts ? b : a));
        result.push({
            icon: 'layers',
            tone: partsTone(worst.parts, view.limits),
            label: 'Fullest partition',
            value: `${number(worst.parts)} parts`,
            detail: `${Math.round((worst.parts / view.limits.throwAt) * 100)}% of the ${number(view.limits.throwAt)} limit`,
        });
    }

    if (readable('disks') && view.disks.length > 0) {
        const free = Math.min(...view.disks.map(disk => (disk.freeBytes / disk.totalBytes) * 100));
        const tightest = view.disks.reduce((a, b) => (b.freeBytes / b.totalBytes < a.freeBytes / a.totalBytes ? b : a));
        result.push({
            icon: 'server',
            tone: diskTone(free),
            label: 'Least free disk',
            value: `${free.toFixed(1)}% free`,
            detail: `${tightest.name}, ${formatBytes(tightest.freeBytes)} left`,
        });
    }

    if (readable('mutations')) {
        const failing = view.mutations.filter(mutation => mutation.failReason).length;
        result.push({
            icon: 'edit',
            tone: failing > 0 ? 'bad' : view.mutations.length > 0 ? 'warn' : 'good',
            label: 'Mutations',
            value: number(view.mutations.length),
            detail: failing > 0 ? `${failing} failing` : view.mutations.length > 0 ? 'None failing' : 'None pending',
        });
    }

    if (readable('merges')) {
        const longest = view.merges.reduce((a, b) => Math.max(a, b.elapsedSeconds), 0);
        result.push({
            icon: 'merge',
            tone: 'none',
            label: 'Merges running',
            value: number(view.merges.length),
            detail: view.merges.length > 0 ? `Longest ${duration(longest)}` : 'Idle',
        });
    }

    if (readable('detached parts')) {
        const parts = view.detached.reduce((sum, group) => sum + group.parts, 0);
        const set = view.detached.some(group => group.reason);
        result.push({
            icon: 'circle-slash',
            tone: parts === 0 ? 'good' : set ? 'bad' : 'warn',
            label: 'Detached parts',
            value: number(parts),
            detail: parts === 0 ? 'None' : set ? 'Some set aside by the server' : 'Detached by hand',
        });
    }
    return result;
}

function partitionRows(view: HealthView): string[] {
    const delayMark = (view.limits.delayAt / view.limits.throwAt) * 100;
    return view.partitions.map(entry => {
        const tone = partsTone(entry.parts, view.limits);
        const text = `${entry.database}.${entry.table} ${entry.partition}`.toLowerCase();
        return (
            `<tr data-s="${escapeHtml(text)}"><td>${qualified(entry.database, entry.table)}</td>` +
            `<td><span class="chip">${escapeHtml(entry.partition || '(none)')}</span></td>` +
            `<td class="meterbox"><span class="n ${tone}">${number(entry.parts)}</span>` +
            `${bar((entry.parts / view.limits.throwAt) * 100, tone, delayMark)}</td>` +
            `<td class="n">${number(entry.rows)}</td><td class="n">${escapeHtml(formatBytes(entry.bytes))}</td></tr>`
        );
    });
}

export function renderHealth(view: HealthView, findings: Finding[], fetchedAt: number): string {
    const subject = view.scope ? `${view.scope.database}.${view.scope.table}` : 'this server';
    const parts: string[] = [];

    parts.push(
        `<header><div><h1><span class="title-icon">${iconSvg('pulse')}</span>Storage health ` +
            `<span class="focusname">${escapeHtml(subject)}</span></h1>` +
            `<p class="note">Read at ${escapeHtml(new Date(fetchedAt).toLocaleTimeString())}. ` +
            'Everything here only reads.</p></div>' +
            `<button id="refresh" type="button">${iconSvg('refresh')}Refresh</button></header>`
    );

    if (view.unavailable.length > 0) {
        parts.push(
            `<p class="gap">${iconSvg('warning')}<span>Could not read: ${escapeHtml(view.unavailable.join(', '))}. ` +
                'These are missing from the page, which is not the same as being healthy.</span></p>'
        );
    }

    parts.push(`<div class="tiles">${tiles(view, findings).map(tileHtml).join('')}</div>`);

    parts.push(
        findings.length > 0
            ? section('warning', 'Findings', findings.map(findingCard).join(''))
            : section(
                  'check',
                  'Findings',
                  view.unavailable.length >= 5
                      ? '<p class="note">Nothing could be read, so nothing can be said.</p>'
                      : `<p class="ok">${iconSvg('check')}Nothing to report: no partition near its limit, no stuck mutation, ` +
                            'disks with room, nothing detached.</p>'
              )
    );

    if (view.partitions.length > 0) {
        const limits = view.limitsFromServer
            ? `Inserts slow from ${view.limits.delayAt} parts in one partition and fail at ${view.limits.throwAt} (this server's settings).`
            : `Inserts slow from ${view.limits.delayAt} parts in one partition and fail at ${view.limits.throwAt} (ClickHouse defaults; this server could not be asked, and a table may override them).`;
        parts.push(
            section(
                'layers',
                'Most fragmented partitions',
                '<div class="toolbar">' +
                    `<label class="search">${iconSvg('search')}<input id="search" type="search" ` +
                    'placeholder="Search tables and partitions…" autocomplete="off" spellcheck="false"></label>' +
                    '<span class="legend"><span class="swatch good"></span>fine' +
                    '<span class="swatch warn"></span>inserts slowed<span class="swatch bad"></span>near the limit</span>' +
                    '</div>' +
                    table(
                        [
                            { label: 'Table' },
                            { label: 'Partition' },
                            { label: 'Parts against the limit' },
                            { label: 'Rows', numeric: true },
                            { label: 'Size', numeric: true },
                        ],
                        partitionRows(view),
                        '',
                        'rows'
                    ) +
                    '<p id="none" class="empty" hidden>No partition matches that search.</p>' +
                    '<div class="pager"><span id="info" class="sub"></span><div class="spacer"></div>' +
                    '<label class="sub">Per page <select id="size"><option>10</option><option selected>25</option>' +
                    '<option>50</option><option>100</option></select></label>' +
                    `<button type="button" id="prev" class="icon-btn" title="Previous page">${iconSvg('chevron-left')}</button>` +
                    '<span id="pageno" class="sub"></span>' +
                    `<button type="button" id="next" class="icon-btn" title="Next page">${iconSvg('chevron-right')}</button></div>`,
                limits
            )
        );
    }

    if (view.mutations.length > 0) {
        parts.push(
            section(
                'edit',
                'Unfinished mutations',
                table(
                    [
                        { label: 'Table' },
                        { label: 'Mutation' },
                        { label: 'Command' },
                        { label: 'Age', numeric: true },
                        { label: 'Parts to do', numeric: true },
                        { label: 'State' },
                    ],
                    view.mutations.map(
                        entry =>
                            `<tr${entry.failReason ? ' class="failing"' : ''}><td>${qualified(entry.database, entry.table)}</td>` +
                            `<td><span class="chip">${escapeHtml(entry.id)}</span></td>` +
                            `<td><code class="sql">${escapeHtml(entry.command.slice(0, 120))}</code></td>` +
                            `<td class="n">${escapeHtml(duration(entry.ageSeconds))}</td>` +
                            `<td class="n">${number(entry.partsToDo)}</td>` +
                            (entry.failReason
                                ? `<td><span class="state bad">${iconSvg('error')}failing</span>` +
                                  `<p class="error">${escapeHtml(entry.failReason.slice(0, 160))}</p></td>`
                                : `<td><span class="state warn">${iconSvg('clock')}pending</span></td>`) +
                            '</tr>'
                    )
                )
            )
        );
    }

    if (view.merges.length > 0) {
        parts.push(
            section(
                'merge',
                'Merges running now',
                table(
                    [
                        { label: 'Table' },
                        { label: 'Kind' },
                        { label: 'Elapsed', numeric: true },
                        { label: 'Progress' },
                        { label: 'Parts', numeric: true },
                        { label: 'Size', numeric: true },
                    ],
                    view.merges.map(entry => {
                        const percent = Math.round(entry.progress * 100);
                        return (
                            `<tr><td>${qualified(entry.database, entry.table)}</td>` +
                            `<td><span class="chip">${entry.isMutation ? 'mutation' : 'merge'}</span></td>` +
                            `<td class="n${entry.elapsedSeconds >= 3600 ? ' warn' : ''}">${escapeHtml(duration(entry.elapsedSeconds))}</td>` +
                            `<td class="meterbox"><span class="n">${percent}%</span>${bar(percent, 'none')}</td>` +
                            `<td class="n">${number(entry.numParts)}</td>` +
                            `<td class="n">${escapeHtml(formatBytes(entry.bytes))}</td></tr>`
                        );
                    })
                )
            )
        );
    }

    if (view.disks.length > 0) {
        parts.push(
            section(
                'server',
                'Disks',
                table(
                    [
                        { label: 'Disk' },
                        { label: 'Usage' },
                        { label: 'Free', numeric: true },
                        { label: 'Total', numeric: true },
                    ],
                    view.disks.map(entry => {
                        const free = (entry.freeBytes / entry.totalBytes) * 100;
                        const tone = diskTone(free);
                        // The bar shows what is used, so it fills as trouble nears.
                        return (
                            `<tr><td><span class="tname">${escapeHtml(entry.name)}</span></td>` +
                            `<td class="meterbox"><span class="n ${tone}">${free.toFixed(1)}% free</span>${bar(100 - free, tone)}</td>` +
                            `<td class="n">${escapeHtml(formatBytes(entry.freeBytes))}</td>` +
                            `<td class="n">${escapeHtml(formatBytes(entry.totalBytes))}</td></tr>`
                        );
                    })
                )
            )
        );
    }

    if (view.detached.length > 0) {
        parts.push(
            section(
                'circle-slash',
                'Detached parts',
                table(
                    [{ label: 'Table' }, { label: 'Reason' }, { label: 'Parts', numeric: true }],
                    view.detached.map(
                        entry =>
                            `<tr><td>${qualified(entry.database, entry.table)}</td>` +
                            `<td>${
                                entry.reason
                                    ? `<span class="state bad">${iconSvg('warning')}${escapeHtml(entry.reason)}</span>`
                                    : '<span class="chip">detached by hand</span>'
                            }</td>` +
                            `<td class="n">${number(entry.parts)}</td></tr>`
                    )
                )
            )
        );
    }

    return parts.join('\n');
}

/**
 * The page's own script: Refresh, and searching and paging the partition list in
 * place. Shared with the panel so the page and what is tested are one thing.
 */
export const HEALTH_SCRIPT = `
const api = acquireVsCodeApi();
const refresh = document.getElementById('refresh');
if (refresh) refresh.addEventListener('click', () => api.postMessage({ type: 'refresh' }));

const tbody = document.getElementById('rows');
if (tbody) {
  const every = Array.from(tbody.querySelectorAll('tr[data-s]'));
  const search = document.getElementById('search');
  const size = document.getElementById('size');
  const state = { page: 0, shown: every };
  const update = () => {
    const pageSize = Number(size.value) || 25;
    const pages = Math.max(1, Math.ceil(state.shown.length / pageSize));
    state.page = Math.min(Math.max(state.page, 0), pages - 1);
    const from = state.page * pageSize;
    const visible = state.shown.slice(from, from + pageSize);
    every.forEach(row => { row.hidden = true; });
    visible.forEach(row => { row.hidden = false; });
    document.getElementById('none').hidden = state.shown.length > 0;
    document.getElementById('info').textContent = state.shown.length === 0 ? '' :
      (from + 1) + '–' + (from + visible.length) + ' of ' + state.shown.length +
      (state.shown.length < every.length ? ' (filtered from ' + every.length + ')' : '');
    document.getElementById('pageno').textContent = 'Page ' + (state.page + 1) + ' of ' + pages;
    document.getElementById('prev').disabled = state.page === 0;
    document.getElementById('next').disabled = state.page >= pages - 1;
  };
  search.addEventListener('input', () => {
    const terms = (search.value || '').toLowerCase().split(/\\s+/).filter(Boolean);
    state.shown = every.filter(row => terms.every(term => row.dataset.s.includes(term)));
    state.page = 0;
    update();
  });
  size.addEventListener('change', () => { state.page = 0; update(); });
  document.getElementById('prev').addEventListener('click', () => { state.page--; update(); });
  document.getElementById('next').addEventListener('click', () => { state.page++; update(); });
  update();
}
`;

/** Uses the editor's own colours, so it is right in any theme. */
export const HEALTH_STYLE = `
* { box-sizing: border-box; }
:root { --line: var(--vscode-panel-border, rgba(128,128,128,.35)); --good: var(--vscode-testing-iconPassed, #3fb950);
  --warn: var(--vscode-editorWarning-foreground, #cca700); --bad: var(--vscode-editorError-foreground, #f85149);
  --accent: var(--vscode-charts-blue, #3794ff); }
body { margin: 0; padding: 16px 24px 32px; font-family: var(--vscode-font-family); font-size: 13px;
  color: var(--vscode-foreground); background: var(--vscode-editor-background); }
svg { flex: none; vertical-align: -3px; }
header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
h1 { font-size: 18px; margin: 0 0 4px; font-weight: 600; }
h2 { display: flex; align-items: center; gap: 8px; font-size: 12px; margin: 30px 0 10px; text-transform: uppercase;
  letter-spacing: .06em; color: var(--vscode-descriptionForeground); font-weight: 600; }
h3 { font-size: 13px; margin: 0; font-weight: 600; }
p { margin: 4px 0; line-height: 1.5; }
.note, .evidence, .sub { color: var(--vscode-descriptionForeground); }
.ok { display: flex; align-items: center; gap: 8px; color: var(--good); }
.gap { display: flex; gap: 10px; align-items: flex-start; margin-top: 14px; padding: 10px 12px; border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--warn) 45%, transparent); background: color-mix(in srgb, var(--warn) 10%, transparent); }
.gap svg { color: var(--warn); margin-top: 1px; }
button { font: inherit; padding: 4px 12px; border: 0; cursor: pointer; border-radius: 4px;
  color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
button:hover { background: var(--vscode-button-hoverBackground); }
header button { display: inline-flex; align-items: center; gap: 6px; }
.spacer { flex: 1; }

.finding { display: flex; gap: 12px; padding: 12px 14px; margin-bottom: 8px; border-radius: 8px;
  border: 1px solid var(--line); background: var(--vscode-editorWidget-background); --tone: var(--vscode-descriptionForeground); }
.finding.high { --tone: var(--bad); border-color: color-mix(in srgb, var(--bad) 45%, var(--line)); }
.finding.medium { --tone: var(--warn); border-color: color-mix(in srgb, var(--warn) 40%, var(--line)); }
.finding.low { --tone: var(--accent); }
.fi { flex: none; display: grid; place-items: center; width: 30px; height: 30px; border-radius: 7px; color: var(--tone);
  background: color-mix(in srgb, var(--tone) 16%, transparent); }
.fi svg { width: 17px; height: 17px; }
.fbody { min-width: 0; flex: 1; }
.fhead { display: flex; align-items: center; gap: 10px; }
.badge { font-size: 10px; text-transform: uppercase; letter-spacing: .06em; padding: 1px 8px; border-radius: 9px;
  color: var(--tone); border: 1px solid color-mix(in srgb, var(--tone) 50%, transparent); }
.suggest { margin-top: 6px; padding-left: 10px; border-left: 2px solid var(--line); }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 4px 12px 4px 0; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.3)); }
th { font-weight: 600; color: var(--vscode-descriptionForeground); }
.n { text-align: right; }
code { font-family: var(--vscode-editor-font-family); font-size: 12px; }
.title-icon { display: inline-grid; place-items: center; width: 26px; height: 26px; margin-right: 8px; border-radius: 7px;
  vertical-align: -5px; color: var(--accent); background: color-mix(in srgb, var(--accent) 16%, transparent); }
.focusname { font-size: 14px; font-weight: 500; color: var(--vscode-descriptionForeground); margin-left: 6px; }
`;

/** What only the health page needs, on top of the base. */
export const HEALTH_PAGE_STYLE = `
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 10px; margin-top: 18px; }
.tile { display: flex; gap: 12px; align-items: center; padding: 12px 14px; border-radius: 10px; border: 1px solid var(--line);
  background: var(--vscode-editorWidget-background); --tone: var(--vscode-descriptionForeground); }
.tile.good { --tone: var(--good); } .tile.warn { --tone: var(--warn); } .tile.bad { --tone: var(--bad); }
.tile.bad { border-color: color-mix(in srgb, var(--bad) 45%, var(--line)); }
.ti { flex: none; display: grid; place-items: center; width: 34px; height: 34px; border-radius: 9px; color: var(--tone);
  background: color-mix(in srgb, var(--tone) 16%, transparent); }
.ti svg { width: 19px; height: 19px; }
.tl { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--vscode-descriptionForeground); }
.tv { font-size: 18px; font-weight: 600; line-height: 1.25; }
.tile.bad .tv { color: var(--bad); } .tile.warn .tv { color: var(--warn); }
.td { font-size: 11px; color: var(--vscode-descriptionForeground); }

.tablewrap { overflow-x: auto; border-radius: 8px; border: 1px solid var(--line); }
table.grid th, table.grid td { padding: 8px 12px; vertical-align: middle; border-bottom: 1px solid var(--line); }
table.grid thead th { background: var(--vscode-editorWidget-background); white-space: nowrap; font-size: 11px;
  text-transform: uppercase; letter-spacing: .05em; }
table.grid tbody tr:last-child td { border-bottom: 0; }
table.grid tbody tr:hover { background: color-mix(in srgb, var(--accent) 7%, transparent); }
table.grid tr.failing td:first-child { box-shadow: inset 3px 0 0 var(--bad); }
table.grid td.warn { color: var(--warn); font-weight: 600; }
.names { display: flex; flex-direction: column; min-width: 0; }
.tname { font-weight: 600; }
.db { font-size: 11px; color: var(--vscode-descriptionForeground); }
.chip { display: inline-block; padding: 1px 8px; font-size: 11px; border-radius: 10px; white-space: nowrap;
  color: var(--vscode-descriptionForeground); border: 1px solid var(--line); }
.state { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 600; }
.state svg { width: 14px; height: 14px; }
.state.bad { color: var(--bad); } .state.warn { color: var(--warn); }
.error { margin: 4px 0 0; font-size: 12px; color: var(--bad); font-family: var(--vscode-editor-font-family); }
code.sql { white-space: pre-wrap; word-break: break-word; }

.meterbox { min-width: 200px; }
.meterbox .n { display: inline-block; margin-bottom: 4px; font-weight: 600; text-align: left; }
.n.good { color: var(--good); } .n.warn { color: var(--warn); } .n.bad { color: var(--bad); }
.meter { position: relative; display: block; height: 6px; border-radius: 3px; background: color-mix(in srgb, var(--vscode-foreground) 12%, transparent); }
.meter .fill { display: block; width: var(--w); height: 100%; border-radius: 3px; background: var(--accent); }
.meter.good .fill { background: var(--good); } .meter.warn .fill { background: var(--warn); } .meter.bad .fill { background: var(--bad); }
.meter .mark { position: absolute; top: -2px; bottom: -2px; left: var(--m); width: 2px; border-radius: 1px;
  background: var(--vscode-foreground); opacity: .55; }

.toolbar, .pager { display: flex; align-items: center; gap: 10px; margin: 10px 0; }
.legend { display: inline-flex; align-items: center; gap: 6px; margin-left: auto; font-size: 11px; color: var(--vscode-descriptionForeground); }
.swatch { width: 9px; height: 9px; border-radius: 50%; margin-left: 8px; background: var(--good); }
.swatch.warn { background: var(--warn); } .swatch.bad { background: var(--bad); }
.search { display: flex; align-items: center; gap: 8px; flex: 0 1 380px; padding: 0 10px; border-radius: 6px;
  color: var(--vscode-descriptionForeground); background: var(--vscode-input-background, var(--vscode-editorWidget-background));
  border: 1px solid var(--vscode-input-border, var(--line)); }
.search:focus-within { border-color: var(--vscode-focusBorder); }
.search input { flex: 1; min-width: 0; padding: 6px 0; font: inherit; color: var(--vscode-input-foreground, var(--vscode-foreground));
  background: none; border: 0; outline: 0; }
button.icon-btn { display: inline-grid; place-items: center; padding: 4px 6px; background: transparent;
  color: var(--vscode-foreground); border: 1px solid var(--line); }
button.icon-btn:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.2)); }
button:disabled { opacity: .4; cursor: default; }
select { font: inherit; padding: 3px 6px; color: var(--vscode-dropdown-foreground, var(--vscode-foreground));
  background: var(--vscode-dropdown-background, var(--vscode-editorWidget-background));
  border: 1px solid var(--vscode-dropdown-border, var(--line)); border-radius: 3px; }
.empty { margin: 16px 0; color: var(--vscode-descriptionForeground); }
`;
