/**
 * The lineage page: what feeds a table above it, what it feeds below.
 *
 * Data runs down the page. The sources are at the top, converging on the table
 * being looked at, and what it writes to fans out underneath. Each table is a
 * card wearing the icon the explorer gives it, and clicking a card looks from
 * there instead. Escaped like the other pages: a table name is data from a
 * server.
 */
import { Finding } from '../advice/types';
import { engineIcon } from '../client/engineIcons';
import { findingCard, escapeHtml } from '../health/render';
import { LineageNode } from './graph';
import { iconSvg, iconTone } from '../webview/icons';

/** Only the hops that are not a view get a label: a view's icon already says it. */
const EDGE_LABEL: Record<string, string> = {
    distributed: 'distributed',
    buffer: 'buffer',
};

/** `database.table` back into its parts, for a table the server does not have. */
function parts(entry: LineageNode): { database: string; table: string } {
    if (entry.row) return { database: entry.row.database, table: entry.row.name };
    const dot = entry.name.indexOf('.');
    return dot < 0
        ? { database: '', table: entry.name }
        : { database: entry.name.slice(0, dot), table: entry.name.slice(dot + 1) };
}

function card(entry: LineageNode, role: 'focus' | 'link' | 'plain'): string {
    const missing = !entry.row;
    const icon = missing ? 'error' : engineIcon(entry.row?.engine);
    const { database, table } = parts(entry);
    const inner =
        `<span class="icon tone-${iconTone(icon)}">${iconSvg(icon)}</span>` +
        `<span class="names"><span class="tname">${escapeHtml(table)}</span>` +
        `<span class="db">${escapeHtml(database)}</span></span>` +
        (entry.row ? `<span class="engine">${escapeHtml(entry.row.engine)}</span>` : '') +
        (missing ? '<span class="flag bad">does not exist</span>' : '') +
        (entry.cycle ? '<span class="flag">already shown</span>' : '');
    const classes = `card${role === 'focus' ? ' focus' : ''}${missing ? ' missing' : ''}`;
    const title = escapeHtml(entry.name);
    return role === 'link'
        ? `<button type="button" class="${classes}" data-focus="${title}" title="${title}">${inner}</button>`
        : `<div class="${classes}" title="${title}">${inner}</div>`;
}

/** A card that can be looked from, unless it is gone or already drawn higher up. */
const cardFor = (entry: LineageNode): string => card(entry, entry.row && !entry.cycle ? 'link' : 'plain');

/** The line between two cards, with the kind of hop on it when that is not obvious. */
function link(kind: string | undefined): string {
    const label = kind ? EDGE_LABEL[kind] : undefined;
    return `<div class="link">${label ? `<span class="hop">${escapeHtml(label)}</span>` : ''}</div>`;
}

/** Everything that flows into `entry`, sources first, `entry`'s own card last. */
function above(entry: LineageNode, showSelf: boolean): string {
    const branches = entry.children.map(child => `<div class="branch">${above(child, true)}${link(child.kind)}</div>`);
    const fan = branches.length > 0 ? `<div class="fan up">${branches.join('')}</div>` : '';
    // Several sources meet on a bar, which then runs into the card.
    return fan + (branches.length > 1 ? '<div class="stem"></div>' : '') + (showSelf ? cardFor(entry) : '');
}

/** Everything `entry` flows into, its own card first. */
function below(entry: LineageNode, showSelf: boolean): string {
    const branches = entry.children.map(child => `<div class="branch">${link(child.kind)}${below(child, true)}</div>`);
    const fan = branches.length > 0 ? `<div class="fan down">${branches.join('')}</div>` : '';
    return (showSelf ? cardFor(entry) : '') + (branches.length > 1 ? '<div class="stem"></div>' : '') + fan;
}

export function renderLineage(
    focus: string,
    upstream: LineageNode,
    downstream: LineageNode,
    findings: Finding[]
): string {
    const connected = upstream.children.length > 0 || downstream.children.length > 0;
    const hasUp = upstream.children.length > 0;
    const hasDown = downstream.children.length > 0;

    // The focus card is drawn once, from the downstream tree, which has the same root.
    const diagram = connected
        ? '<div class="scroll"><div class="flow">' +
          (hasUp ? '<div class="caption">Feeds this table</div>' : '') +
          above(upstream, false) +
          card(downstream, 'focus') +
          (hasDown ? '<div class="caption below">Fed by this table</div>' : '') +
          below(downstream, false) +
          '</div></div>'
        : '<p class="sub">Nothing feeds this table and it feeds nothing, as far as this server runs it.</p>';

    return [
        `<header><div><h1>Lineage <span class="focusname">${escapeHtml(focus)}</span></h1>` +
            '<p class="sub">What ClickHouse itself runs: materialized views, Distributed and Buffer tables. ' +
            'Anything fed from outside the server, such as Kafka consumers or an ETL job, is not visible here. ' +
            'Everything here only reads. Click a table to look from there.</p></div>' +
            '<button id="refresh" type="button">Refresh</button></header>',
        findings.length > 0 ? `<section><h2>Findings</h2>${findings.map(findingCard).join('')}</section>` : '',
        diagram,
    ].join('\n');
}

export const LINEAGE_STYLE = `
:root { --line: var(--vscode-panel-border, rgba(128,128,128,.45)); }
.focusname { font-family: var(--vscode-editor-font-family); font-size: 14px; font-weight: 500;
  color: var(--vscode-descriptionForeground); margin-left: 6px; }
.sub { color: var(--vscode-descriptionForeground); }
header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }

.scroll { overflow-x: auto; padding: 8px 0 24px; margin-top: 20px; }
.flow { display: flex; flex-direction: column; align-items: center; width: max-content; min-width: 100%; }
.caption { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; font-weight: 600;
  color: var(--vscode-descriptionForeground); margin: 4px 0 10px; }
.caption.below { margin: 12px 0 0; }
.fan { display: flex; justify-content: center; align-items: flex-start; }
.branch { position: relative; display: flex; flex-direction: column; align-items: center; padding: 0 12px; }
.stem { width: 2px; height: 14px; background: var(--line); }

/* Where several branches meet or part, a bar joins them, running from the first to the last. */
.fan > .branch:not(:only-child)::before { content: ''; position: absolute; left: 0; right: 0; border-top: 2px solid var(--line); }
.fan.down > .branch::before { top: 0; }
.fan.up > .branch::before { bottom: 0; }
.fan > .branch:first-child::before { left: 50%; }
.fan > .branch:last-child::before { right: 50%; }

.link { position: relative; width: 2px; height: 26px; margin: 0 auto; background: var(--line); }
.link::after { content: ''; position: absolute; left: -4px; bottom: -1px; width: 7px; height: 7px;
  border-right: 2px solid var(--line); border-bottom: 2px solid var(--line); transform: rotate(45deg) translate(-1px, -1px); }
.hop { position: absolute; top: 50%; left: 10px; transform: translateY(-50%); white-space: nowrap; font-size: 10px;
  padding: 1px 7px; border-radius: 9px; color: var(--vscode-descriptionForeground);
  background: var(--vscode-editorWidget-background); border: 1px solid var(--line); }

.card { display: flex; align-items: center; gap: 10px; min-width: 190px; max-width: 340px; padding: 8px 12px 8px 8px;
  border-radius: 8px; text-align: left; font: inherit; color: var(--vscode-foreground);
  background: var(--vscode-editorWidget-background); border: 1px solid var(--line);
  box-shadow: 0 1px 2px rgba(0,0,0,.18); }
button.card { cursor: pointer; transition: border-color .12s, transform .12s, box-shadow .12s; }
button.card:hover { background: var(--vscode-editorWidget-background); border-color: var(--vscode-focusBorder);
  transform: translateY(-1px); box-shadow: 0 3px 8px rgba(0,0,0,.25); }
button.card:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
.card.focus { border-color: var(--vscode-focusBorder); padding: 12px 16px 12px 12px; min-width: 240px;
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--vscode-focusBorder) 25%, transparent), 0 2px 8px rgba(0,0,0,.25); }
.card.focus .tname { font-size: 15px; }
.card.missing { border-style: dashed; border-color: var(--vscode-editorError-foreground, #f85149); }
.card.missing .tname { color: var(--vscode-editorError-foreground, #f85149); text-decoration: line-through; }

.icon { flex: none; display: grid; place-items: center; width: 30px; height: 30px; border-radius: 7px;
  color: var(--tone); background: color-mix(in srgb, var(--tone) 16%, transparent); }
.icon svg { width: 17px; height: 17px; }
.tone-store { --tone: var(--vscode-charts-green, #89d185); }
.tone-live { --tone: var(--vscode-charts-yellow, #e2c08d); }
.tone-route { --tone: var(--vscode-charts-blue, #75beff); }
.tone-outside { --tone: var(--vscode-charts-orange, #d18616); }
.tone-bad { --tone: var(--vscode-editorError-foreground, #f85149); }

.names { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.tname { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.db { font-size: 11px; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; }
.engine { flex: none; font-size: 10px; padding: 1px 7px; border-radius: 9px; color: var(--vscode-descriptionForeground);
  border: 1px solid var(--line); }
.flag { flex: none; font-size: 10px; padding: 1px 7px; border-radius: 9px; color: var(--vscode-descriptionForeground);
  background: var(--vscode-editor-background); }
.flag.bad { color: var(--vscode-editorError-foreground, #f85149); }
`;
