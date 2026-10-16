/**
 * The cluster map.
 *
 * Shards across, replicas down, each box the same size because the shape is
 * what is being shown. Inside a box, a bar for the rows that node holds: a
 * sharding key that does not divide shows up as bars of different lengths in
 * different columns, which is the thing no single node can see.
 *
 * The chrome — toolbar, canvas, findings, summary — is the plan view's, down
 * to the stylesheet. Only the drawing differs.
 */
import { Finding } from '../../advice/types';
import { heatColor, Palette, readPalette, withAlpha } from '../../explain/view/palette';
import { prepareSvgForExport, rasterize } from '../../explain/view/exportImage';
import { formatBytes, formatCount } from '../../results/format';
import { ClusterHostMessage, ClusterPayload, ClusterTransport } from '../protocol';
import { ClusterCell, clusterLayout } from './layout';

const SVG_NS = 'http://www.w3.org/2000/svg';
const ALL_TABLES = 'all tables';

function element<K extends keyof SVGElementTagNameMap>(
    tag: K,
    attributes: Record<string, string | number> = {}
): SVGElementTagNameMap[K] {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
    return node;
}

function html(tag: string, className = '', text = ''): HTMLElement {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

export class ClusterView {
    private readonly canvas: HTMLElement;
    private readonly findingsPane: HTMLElement;
    private readonly findingsToggle: HTMLButtonElement;
    private readonly legend: HTMLElement;
    private readonly summary: HTMLElement;
    private readonly picker: HTMLSelectElement;

    private palette: Palette = readPalette();
    private payload?: ClusterPayload;
    private findings: Finding[] = [];
    private table = ALL_TABLES;

    constructor(
        private readonly root: HTMLElement,
        private readonly transport: ClusterTransport
    ) {
        const plan = html('div', 'ch-plan');
        const pane = html('div', 'ch-pane-plan');

        const bar = html('div', 'ch-toolbar');
        this.picker = document.createElement('select');
        this.picker.className = 'ch-picker';
        this.picker.addEventListener('change', () => {
            this.table = this.picker.value;
            this.draw();
        });

        const refresh = html('button', 'ch-refresh', 'Refresh') as HTMLButtonElement;
        refresh.addEventListener('click', () => this.transport.post({ type: 'refresh' }));

        this.findingsToggle = html('button', 'ch-findings-toggle', 'Findings') as HTMLButtonElement;
        this.findingsToggle.addEventListener('click', () => this.findingsPane.classList.toggle('ch-open'));
        const findingsGroup = html('div', 'ch-views ch-zooms');
        findingsGroup.append(this.findingsToggle);

        const exports = html('div', 'ch-export');
        exports.append(html('span', '', 'Save as'));
        for (const format of ['svg', 'png', 'jpg'] as const) {
            const button = html('button', '', format.toUpperCase()) as HTMLButtonElement;
            button.addEventListener('click', () => void this.exportAs(format));
            exports.append(button);
        }
        bar.append(this.picker, refresh, findingsGroup, exports);

        this.canvas = html('div', 'ch-canvas');
        this.findingsPane = html('div', 'ch-findings');
        const body = html('div', 'ch-plan-body');
        body.append(this.canvas, this.findingsPane);

        this.legend = html('div', 'ch-legend');
        this.summary = html('div', 'ch-summary');
        pane.append(bar, body, this.legend, this.summary);
        plan.append(pane);
        this.root.append(plan);

        this.transport.onMessage(message => this.onMessage(message));
        this.transport.post({ type: 'ready' });
        window.addEventListener('resize', () => this.draw());
    }

    private onMessage(message: ClusterHostMessage): void {
        if (message.type === 'status' || message.type === 'error') {
            this.canvas.replaceChildren(html('div', 'ch-empty', message.message));
            return;
        }
        if (message.type === 'findings') {
            this.findings = message.findings;
            this.renderFindings();
            return;
        }

        this.payload = message.payload;
        this.palette = readPalette();
        this.findings = [];
        this.renderFindings();
        this.fillPicker(message.payload.tables);
        this.renderSummary();
        this.draw();
    }

    private fillPicker(tables: string[]): void {
        const options = [ALL_TABLES, ...tables];
        if (!options.includes(this.table)) this.table = ALL_TABLES;

        this.picker.replaceChildren(
            ...options.map(name => {
                const option = document.createElement('option');
                option.value = name;
                option.textContent = name;
                option.selected = name === this.table;
                return option;
            })
        );
    }

    private renderSummary(): void {
        const view = this.payload?.view;
        if (!view) return;

        const replicated = new Set(view.placement.map(entry => `${entry.database}.${entry.table}`)).size;
        const parts: Array<[string, string]> = [
            ['cluster', view.cluster],
            ['shards', String(new Set(view.hosts.map(host => host.shard)).size)],
            ['replicas', String(view.hosts.length)],
            ['answering', String(view.hosts.length - view.unreachable.length)],
            ['tables', String(replicated)],
        ];

        this.summary.replaceChildren(
            ...parts.map(([label, value]) => {
                const slot = html('span');
                slot.append(`${label} `, html('b', '', value));
                return slot;
            })
        );
    }

    private renderFindings(): void {
        this.findingsToggle.textContent = this.findings.length ? `Findings ${this.findings.length}` : 'Findings';

        if (this.findings.length === 0) {
            this.findingsPane.classList.remove('ch-open');
            this.findingsPane.replaceChildren(html('div', 'ch-findings-empty', 'Nothing wrong that this can see.'));
            return;
        }
        if (this.findings.some(finding => finding.importance === 'high')) {
            this.findingsPane.classList.add('ch-open');
        }

        this.findingsPane.replaceChildren(
            ...this.findings.map(finding => {
                const item = html('div', `ch-finding ch-finding-${finding.importance}`);
                const title = html('div', 'ch-finding-title');
                title.append(
                    html('span', 'ch-finding-mark', finding.importance === 'low' ? '●' : '▲'),
                    html('b', '', finding.title)
                );
                item.append(title, html('div', 'ch-finding-evidence', finding.evidence));
                if (finding.suggestion) item.append(html('div', 'ch-finding-suggestion', finding.suggestion));
                return item;
            })
        );
    }

    private colourFor(cell: ClusterCell): { fill: string; stroke: string } {
        if (cell.state === 'unreachable') {
            return { fill: withAlpha(this.palette.muted, 0.12), stroke: this.palette.hot };
        }
        if (cell.state === 'readonly') return { fill: heatColor(0.9), stroke: this.palette.hot };
        if (cell.state === 'lagging') return { fill: heatColor(0.55), stroke: withAlpha(this.palette.hot, 0.7) };
        return { fill: withAlpha(this.palette.accent, 0.1), stroke: withAlpha(this.palette.border, 0.9) };
    }

    private draw(): void {
        if (!this.payload) return;

        const laid = clusterLayout(this.payload.view, {
            table: this.table === ALL_TABLES ? undefined : this.table,
        });
        const width = Math.max(520, this.canvas.clientWidth - 24);
        const rowsDeep = Math.max(...laid.shards.map(shard => shard.replicas), 1);
        const height = Math.max(240, rowsDeep * 108 + 34);
        const top = 26;

        const svg = element('svg', { viewBox: `0 0 ${width} ${height}`, width, height });

        for (const shard of laid.shards) {
            const label = element('text', {
                x: (shard.x + shard.width / 2) * width,
                y: 16,
                'text-anchor': 'middle',
                class: 'ch-shard-label',
                fill: this.palette.muted,
                'font-size': 11,
            });
            label.textContent = `shard ${shard.shard} · ${shard.replicas} replica${shard.replicas === 1 ? '' : 's'}`;
            svg.append(label);
        }

        for (const cell of laid.cells) {
            const x = cell.x * width;
            const y = top + cell.y * (height - top);
            const w = cell.width * width;
            const h = cell.height * (height - top);
            const colours = this.colourFor(cell);

            const group = element('g', { class: 'ch-cell ch-node' });
            group.append(
                element('rect', {
                    x,
                    y,
                    width: w,
                    height: h,
                    rx: 4,
                    fill: colours.fill,
                    stroke: colours.stroke,
                    'stroke-width': cell.state === 'ok' ? 1 : 1.6,
                    'stroke-dasharray': cell.state === 'unreachable' ? '4 3' : '',
                })
            );

            const name = element('text', {
                x: x + 12,
                y: y + 22,
                fill: this.palette.foreground,
                'font-size': 12,
            });
            name.textContent = `${cell.host}${cell.isLocal ? ' (connected)' : ''}`;
            group.append(name);

            const state = element('text', {
                x: x + 12,
                y: y + 40,
                fill: cell.state === 'ok' ? this.palette.muted : this.palette.hot,
                'font-size': 11,
            });
            state.textContent =
                cell.state === 'ok'
                    ? `${formatCount(cell.rows)} rows · ${formatBytes(cell.bytes)} · ${cell.parts} parts`
                    : cell.state === 'unreachable'
                      ? 'did not answer'
                      : cell.state === 'readonly'
                        ? 'read-only'
                        : 'behind';
            group.append(state);

            // The bar is the only measurement here: how much of the busiest
            // node's data this one holds.
            if (cell.rows > 0) {
                const barY = y + h - 16;
                group.append(
                    element('rect', { x: x + 12, y: barY, width: w - 24, height: 6, rx: 3, fill: withAlpha(this.palette.border, 0.5) }),
                    element('rect', {
                        x: x + 12,
                        y: barY,
                        width: Math.max(2, (w - 24) * cell.share),
                        height: 6,
                        rx: 3,
                        fill: heatColor(cell.share),
                    })
                );
            }

            svg.append(group);
        }

        this.legend.textContent =
            'Shards across, replicas down. Every box is the same size — the bar inside is the rows that node holds.';
        this.canvas.replaceChildren(svg);
    }

    private async exportAs(format: 'svg' | 'png' | 'jpg'): Promise<void> {
        const svg = this.canvas.querySelector('svg');
        if (!svg) return;

        const options = {
            background: this.palette.background,
            width: Number(svg.getAttribute('width')) || 800,
            height: Number(svg.getAttribute('height')) || 400,
        };
        const markup = prepareSvgForExport(svg as SVGSVGElement, options);
        const data = format === 'svg' ? markup : await rasterize(markup, format, options);
        this.transport.post({ type: 'export', format, data });
    }
}
