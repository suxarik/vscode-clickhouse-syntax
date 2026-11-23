/**
 * The lineage page: what feeds a table above it, what it feeds below.
 *
 * Nested lists rather than a drawn graph. A pipeline is a tree from any one
 * table's point of view, a tree reads in order, and every name on it can be
 * clicked to look from there instead. Escaped like the other pages: a table
 * name is data from a server.
 */
import { Finding } from '../advice/types';
import { findingCard, escapeHtml } from '../health/render';
import { LineageNode } from './graph';

const KIND_LABEL: Record<string, string> = {
    'materialized view': 'view',
    distributed: 'distributed',
    buffer: 'buffer',
};

function node(entry: LineageNode, root: boolean): string {
    const missing = !entry.row;
    const label =
        root || missing || entry.cycle
            ? `<span class="tname${missing ? ' missing' : ''}">${escapeHtml(entry.name)}</span>`
            : `<button type="button" class="link" data-focus="${escapeHtml(entry.name)}">${escapeHtml(entry.name)}</button>`;
    const engine = entry.row ? `<span class="engine">${escapeHtml(entry.row.engine)}</span>` : '';
    const flags = [
        missing ? '<span class="flag bad">does not exist</span>' : '',
        entry.cycle ? '<span class="flag">already shown above</span>' : '',
    ].join('');
    const via =
        entry.kind && !root ? `<span class="via">${escapeHtml(KIND_LABEL[entry.kind] ?? entry.kind)}</span>` : '';
    const children =
        entry.children.length > 0
            ? `<ul>${entry.children.map(child => `<li>${node(child, false)}</li>`).join('')}</ul>`
            : '';
    return `<div class="row">${via}${label}${engine}${flags}</div>${children}`;
}

function side(title: string, note: string, tree: LineageNode): string {
    const body =
        tree.children.length > 0 ? `<ul class="tree"><li>${node(tree, true)}</li></ul>` : '<p class="sub">Nothing.</p>';
    return `<section><h2>${escapeHtml(title)}</h2><p class="sub">${escapeHtml(note)}</p>${body}</section>`;
}

export function renderLineage(
    focus: string,
    upstream: LineageNode,
    downstream: LineageNode,
    findings: Finding[]
): string {
    return [
        `<header><div><h1>Lineage — ${escapeHtml(focus)}</h1>` +
            '<p class="sub">What ClickHouse itself runs: materialized views, Distributed and Buffer tables. ' +
            'Anything fed from outside the server, such as Kafka consumers or an ETL job, is not visible here. ' +
            'Everything here only reads.</p></div>' +
            '<button id="refresh" type="button">Refresh</button></header>',
        findings.length > 0 ? `<section><h2>Findings</h2>${findings.map(findingCard).join('')}</section>` : '',
        side('Feeds this table', 'Each line is written to by the one indented beneath it.', upstream),
        side('Fed by this table', 'What runs, and where it lands, when this table is written to.', downstream),
    ].join('\n');
}

export const LINEAGE_STYLE = `
ul { list-style: none; margin: 0; padding-left: 22px; border-left: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35)); }
ul.tree { padding-left: 0; border-left: 0; }
li { margin: 2px 0; }
.row { display: flex; align-items: baseline; gap: 8px; padding: 2px 0; }
.tname { font-weight: 600; }
.tname.missing { color: var(--vscode-editorError-foreground, #f85149); text-decoration: line-through; }
.engine, .via { color: var(--vscode-descriptionForeground); font-size: 11px; }
.via::after { content: ' →'; }
.flag { font-size: 11px; padding: 0 6px; border-radius: 8px; background: var(--vscode-editorWidget-background);
  color: var(--vscode-descriptionForeground); }
.flag.bad { color: var(--vscode-editorError-foreground, #f85149); }
button.link { padding: 0; font-weight: 600; color: var(--vscode-textLink-foreground); background: none; border: 0;
  cursor: pointer; font-family: inherit; font-size: inherit; }
button.link:hover { text-decoration: underline; background: none; }
.sub { color: var(--vscode-descriptionForeground); }
header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
`;
