/**
 * The health panel's page.
 *
 * Plain HTML built here, not in a webview bundle: there is nothing to draw
 * that a table cannot say, and a page with no script of its own has no way to
 * be handed one. Every value from the server is escaped on the way in — a
 * table name or a mutation's error text is data, never markup.
 */
import { Finding } from '../advice/types';
import { formatBytes } from '../results/format';
import { HealthView } from './types';

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

function table(head: string[], body: string[][], numeric: number[] = []): string {
    const cell = (tag: string, value: string, index: number) =>
        `<${tag}${numeric.includes(index) ? ' class="n"' : ''}>${value}</${tag}>`;
    return (
        '<table><thead><tr>' +
        head.map((name, index) => cell('th', escapeHtml(name), index)).join('') +
        '</tr></thead><tbody>' +
        body.map(row => `<tr>${row.map((value, index) => cell('td', value, index)).join('')}</tr>`).join('') +
        '</tbody></table>'
    );
}

function section(title: string, content: string, note?: string): string {
    return `<section><h2>${escapeHtml(title)}</h2>${note ? `<p class="note">${escapeHtml(note)}</p>` : ''}${content}</section>`;
}

function findingCard(finding: Finding): string {
    return (
        `<article class="finding ${finding.importance}">` +
        `<div class="badge">${escapeHtml(finding.importance)}</div>` +
        `<div><h3>${escapeHtml(finding.title)}</h3>` +
        `<p class="evidence">${escapeHtml(finding.evidence)}</p>` +
        (finding.suggestion ? `<p>${escapeHtml(finding.suggestion)}</p>` : '') +
        '</div></article>'
    );
}

export function renderHealth(view: HealthView, findings: Finding[], fetchedAt: number): string {
    const subject = view.scope ? `${view.scope.database}.${view.scope.table}` : 'this server';
    const parts: string[] = [];

    parts.push(
        `<header><div><h1>Storage health — ${escapeHtml(subject)}</h1>` +
            `<p class="note">Read at ${escapeHtml(new Date(fetchedAt).toLocaleTimeString())}. ` +
            'Everything here only reads.</p></div>' +
            '<button id="refresh" type="button">Refresh</button></header>'
    );

    if (view.unavailable.length > 0) {
        parts.push(
            `<p class="gap">Could not read: ${escapeHtml(view.unavailable.join(', '))}. ` +
                'These are missing from the page, which is not the same as being healthy.</p>'
        );
    }

    parts.push(
        findings.length > 0
            ? section('Findings', findings.map(findingCard).join(''))
            : section(
                  'Findings',
                  view.unavailable.length >= 5
                      ? '<p class="note">Nothing could be read, so nothing can be said.</p>'
                      : '<p class="ok">Nothing to report: no partition near its limit, no stuck mutation, ' +
                            'disks with room, nothing detached.</p>'
              )
    );

    if (view.partitions.length > 0) {
        const limits = view.limitsFromServer
            ? `Inserts slow from ${view.limits.delayAt} parts in one partition and fail at ${view.limits.throwAt} (this server's settings).`
            : `Inserts slow from ${view.limits.delayAt} parts in one partition and fail at ${view.limits.throwAt} (ClickHouse defaults; this server could not be asked, and a table may override them).`;
        parts.push(
            section(
                'Most fragmented partitions',
                table(
                    ['Table', 'Partition', 'Parts', 'Rows', 'Size'],
                    view.partitions
                        .slice(0, 15)
                        .map(entry => [
                            escapeHtml(`${entry.database}.${entry.table}`),
                            escapeHtml(entry.partition || '(none)'),
                            number(entry.parts),
                            number(entry.rows),
                            escapeHtml(formatBytes(entry.bytes)),
                        ]),
                    [2, 3, 4]
                ),
                limits
            )
        );
    }

    if (view.mutations.length > 0) {
        parts.push(
            section(
                'Unfinished mutations',
                table(
                    ['Table', 'Mutation', 'Command', 'Age', 'Parts to do', 'Last error'],
                    view.mutations.map(entry => [
                        escapeHtml(`${entry.database}.${entry.table}`),
                        escapeHtml(entry.id),
                        `<code>${escapeHtml(entry.command.slice(0, 120))}</code>`,
                        escapeHtml(duration(entry.ageSeconds)),
                        number(entry.partsToDo),
                        escapeHtml(entry.failReason.slice(0, 160) || '—'),
                    ]),
                    [3, 4]
                )
            )
        );
    }

    if (view.merges.length > 0) {
        parts.push(
            section(
                'Merges running now',
                table(
                    ['Table', 'Kind', 'Elapsed', 'Progress', 'Parts', 'Size'],
                    view.merges.map(entry => [
                        escapeHtml(`${entry.database}.${entry.table}`),
                        entry.isMutation ? 'mutation' : 'merge',
                        escapeHtml(duration(entry.elapsedSeconds)),
                        `${Math.round(entry.progress * 100)}%`,
                        number(entry.numParts),
                        escapeHtml(formatBytes(entry.bytes)),
                    ]),
                    [2, 3, 4, 5]
                )
            )
        );
    }

    if (view.disks.length > 0) {
        parts.push(
            section(
                'Disks',
                table(
                    ['Disk', 'Free', 'Total', 'Free %'],
                    view.disks.map(entry => [
                        escapeHtml(entry.name),
                        escapeHtml(formatBytes(entry.freeBytes)),
                        escapeHtml(formatBytes(entry.totalBytes)),
                        `${((entry.freeBytes / entry.totalBytes) * 100).toFixed(1)}%`,
                    ]),
                    [1, 2, 3]
                )
            )
        );
    }

    if (view.detached.length > 0) {
        parts.push(
            section(
                'Detached parts',
                table(
                    ['Table', 'Reason', 'Parts'],
                    view.detached.map(entry => [
                        escapeHtml(`${entry.database}.${entry.table}`),
                        escapeHtml(entry.reason || 'detached by hand'),
                        number(entry.parts),
                    ]),
                    [2]
                )
            )
        );
    }

    return parts.join('\n');
}

/** Uses the editor's own colours, so it is right in any theme. */
export const HEALTH_STYLE = `
* { box-sizing: border-box; }
body { margin: 0; padding: 16px 24px 32px; font-family: var(--vscode-font-family); font-size: 13px;
  color: var(--vscode-foreground); background: var(--vscode-editor-background); }
header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
h1 { font-size: 18px; margin: 0 0 4px; font-weight: 600; }
h2 { font-size: 13px; margin: 28px 0 8px; text-transform: uppercase; letter-spacing: .04em;
  color: var(--vscode-descriptionForeground); font-weight: 600; }
h3 { font-size: 13px; margin: 0 0 4px; font-weight: 600; }
p { margin: 4px 0; line-height: 1.5; }
.note, .evidence { color: var(--vscode-descriptionForeground); }
.ok { color: var(--vscode-testing-iconPassed, #3fb950); }
.gap { margin-top: 12px; padding: 8px 12px; border-left: 3px solid var(--vscode-editorWarning-foreground, #cca700);
  background: var(--vscode-editorWidget-background); }
button { font: inherit; padding: 4px 12px; border: 0; cursor: pointer; border-radius: 2px;
  color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
button:hover { background: var(--vscode-button-hoverBackground); }
.finding { display: flex; gap: 12px; padding: 10px 12px; margin-bottom: 8px; border-radius: 3px;
  background: var(--vscode-editorWidget-background); border-left: 3px solid var(--vscode-descriptionForeground); }
.finding.high { border-left-color: var(--vscode-editorError-foreground, #f85149); }
.finding.medium { border-left-color: var(--vscode-editorWarning-foreground, #cca700); }
.badge { flex: none; width: 52px; font-size: 11px; text-transform: uppercase; letter-spacing: .04em;
  color: var(--vscode-descriptionForeground); padding-top: 2px; }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 4px 12px 4px 0; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.3)); }
th { font-weight: 600; color: var(--vscode-descriptionForeground); }
.n { text-align: right; }
code { font-family: var(--vscode-editor-font-family); font-size: 12px; }
`;
