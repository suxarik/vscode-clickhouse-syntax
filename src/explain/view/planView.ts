/**
 * The plan view.
 *
 * Two drawings of one graph. The flame answers "where did the time go" by
 * making the answer the widest thing on screen; the node-link view answers
 * "what shape is this query" by drawing the pipeline. Both are measurements
 * rather than diagrams: a box's size is its cost, never a fixed card.
 *
 * `elapsed_us` is CPU time summed over every thread, so it is labelled as CPU
 * time and shown next to the wall clock from `query_log`. Presenting one as the
 * other would be a lie the picture would make very convincing.
 */
import { PlanHostMessage, PlanPayload, PlanTransport, ImageFormat } from '../protocol';
import { FlameCell, dagLayout, flameLayout, DagLayoutResult } from './layout';
import { Palette, heatColor, readPalette, withAlpha } from './palette';
import { prepareSvgForExport, rasterize } from './exportImage';
import { formatBytes, formatCount } from '../../results/format';

const SVG_NS = 'http://www.w3.org/2000/svg';
const ROW = 26;
const MIN_CANVAS = 560;
/** Natural sizes: what "1:1" means, independent of the panel's width. */
const FLAME_WIDTH = 1080;
/** Arrowhead length in pixels, the same on every edge. */
const ARROW = 11;
/** How far the tip rests from the box it points at. */
const ARROW_GAP = 3;
/** Pixels a layer gap must have for an arrow and a visible line to fit in it. */
const ARROW_ROOM = 38;
/** How far one press of + or − moves, and how far they may go. */
const ZOOM_STEP = 1.3;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 5;
const GRAPH_WIDTH = 860;

type ViewKind = 'flame' | 'graph';
/** `fit` recomputes on every resize; a number is a fixed scale. */
type Zoom = 'fit' | number;

export function formatDuration(microseconds: number): string {
    if (microseconds < 1000) return `${Math.round(microseconds)}µs`;
    if (microseconds < 1_000_000) return `${(microseconds / 1000).toFixed(microseconds < 10_000 ? 1 : 0)}ms`;
    return `${(microseconds / 1_000_000).toFixed(2)}s`;
}

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

/** Roughly how many characters fit, so a label is cut rather than overflowing. */
function fit(label: string, pixels: number): string {
    const room = Math.floor((pixels - 10) / 6.1);
    if (room < 2) return '';
    return label.length <= room ? label : `${label.slice(0, room - 1)}…`;
}

export class PlanView {
    private readonly explainBody: HTMLElement;
    private readonly canvas: HTMLElement;
    private readonly summary: HTMLElement;
    private readonly legend: HTMLElement;
    private readonly tip: HTMLElement;
    private readonly buttons = new Map<ViewKind, HTMLButtonElement>();

    private palette: Palette = readPalette();
    private kind: ViewKind = 'flame';
    private zoom: Zoom = 'fit';
    /** The scale actually applied, so stepping in starts from what is on screen. */
    private appliedScale = 1;
    /** Set while a drag is panning, so the drag does not also select a step. */
    private panned = false;
    private readonly zoomButtons = new Map<string, HTMLButtonElement>();
    private payload?: PlanPayload;
    private selected?: string;

    constructor(
        private readonly root: HTMLElement,
        private readonly transport: PlanTransport
    ) {
        const plan = html('div', 'ch-plan');

        const explainPane = html('div', 'ch-pane-explain');
        explainPane.append(html('div', 'ch-explain-head', 'EXPLAIN PLAN'));
        this.explainBody = html('pre', 'ch-explain-body');
        explainPane.append(this.explainBody);

        const divider = html('div', 'ch-divider');
        this.makeResizable(divider, explainPane);

        const planPane = html('div', 'ch-pane-plan');
        planPane.append(this.toolbar());
        this.canvas = html('div', 'ch-canvas');
        this.legend = html('div', 'ch-legend');
        this.summary = html('div', 'ch-summary');
        planPane.append(this.canvas, this.legend, this.summary);

        this.makePannable(this.canvas);

        this.tip = html('div', 'ch-tip');
        this.tip.style.display = 'none';
        this.canvas.append(this.tip);

        plan.append(explainPane, divider, planPane);
        this.root.append(plan);

        this.transport.onMessage(message => this.onMessage(message));
        this.transport.post({ type: 'ready' });
        window.addEventListener('resize', () => this.draw());
    }

    private toolbar(): HTMLElement {
        const bar = html('div', 'ch-toolbar');

        const views = html('div', 'ch-views');
        for (const [kind, label] of [
            ['flame', 'Flame'],
            ['graph', 'Graph'],
        ] as Array<[ViewKind, string]>) {
            const button = html('button', kind === this.kind ? 'ch-on' : '', label) as HTMLButtonElement;
            button.addEventListener('click', () => this.show(kind));
            this.buttons.set(kind, button);
            views.append(button);
        }

        const zooms = html('div', 'ch-views ch-zooms');
        for (const [key, label, title] of [
            ['out', '−', 'Zoom out'],
            ['fit', 'Fit', 'Scale the drawing to the panel'],
            ['one', '1:1', 'Draw at natural size'],
            ['in', '+', 'Zoom in'],
        ] as Array<[string, string, string]>) {
            const button = html('button', key === 'fit' ? 'ch-on' : '', label) as HTMLButtonElement;
            button.title = title;
            button.addEventListener('click', () => {
                if (key === 'fit') this.setZoom('fit');
                else if (key === 'one') this.setZoom(1);
                else this.setZoom(this.stepped(key === 'in' ? ZOOM_STEP : 1 / ZOOM_STEP));
            });
            this.zoomButtons.set(key, button);
            zooms.append(button);
        }

        const exports = html('div', 'ch-export');
        exports.append(html('span', '', 'Save as'));
        for (const format of ['svg', 'png', 'jpg'] as ImageFormat[]) {
            const button = html('button', '', format.toUpperCase()) as HTMLButtonElement;
            button.addEventListener('click', () => void this.exportAs(format));
            exports.append(button);
        }

        bar.append(views, zooms, exports);
        return bar;
    }

    /** Drag the divider; the panes keep whatever ratio the reader chose. */
    private makeResizable(divider: HTMLElement, pane: HTMLElement): void {
        let dragging = false;
        divider.addEventListener('mousedown', event => {
            dragging = true;
            divider.classList.add('ch-dragging');
            event.preventDefault();
        });
        window.addEventListener('mousemove', event => {
            if (!dragging) return;
            const fraction = Math.min(0.75, Math.max(0.12, event.clientX / window.innerWidth));
            pane.style.width = `${(fraction * 100).toFixed(1)}%`;
            this.draw();
        });
        window.addEventListener('mouseup', () => {
            dragging = false;
            divider.classList.remove('ch-dragging');
        });
    }

    private onMessage(message: PlanHostMessage): void {
        if (message.type === 'status') {
            this.canvas.querySelector('.ch-empty')?.remove();
            this.canvas.append(html('div', 'ch-empty', message.message));
            return;
        }
        if (message.type === 'error') {
            this.canvas.replaceChildren(this.tip, html('div', 'ch-empty', message.message));
            return;
        }

        this.payload = message.payload;
        this.palette = readPalette();
        this.renderExplain(message.payload.explain);
        this.renderSummary(message.payload);
        this.draw();
    }

    /** A step from whatever is on screen, so + continues from Fit. */
    private stepped(factor: number): number {
        return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.appliedScale * factor));
    }

    private setZoom(zoom: Zoom): void {
        this.zoom = zoom;
        for (const [key, button] of this.zoomButtons) {
            const on = key === 'fit' ? zoom === 'fit' : key === 'one' && zoom === 1;
            button.className = on ? 'ch-on' : '';
        }
        this.draw();
    }

    /**
     * Drag to move the drawing.
     *
     * Scrollbars alone are not enough once someone has zoomed in: the thing
     * they want to move is under the pointer, so that is what they reach for.
     */
    private makePannable(canvas: HTMLElement): void {
        let from: { x: number; y: number; left: number; top: number } | undefined;

        canvas.addEventListener('mousedown', event => {
            from = { x: event.clientX, y: event.clientY, left: canvas.scrollLeft, top: canvas.scrollTop };
            this.panned = false;
            canvas.classList.add('ch-panning');
        });

        window.addEventListener('mousemove', event => {
            if (!from) return;
            const dx = event.clientX - from.x;
            const dy = event.clientY - from.y;
            // A few pixels of travel is a click with a shaky hand, not a pan.
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) this.panned = true;
            canvas.scrollLeft = from.left - dx;
            canvas.scrollTop = from.top - dy;
        });

        window.addEventListener('mouseup', () => {
            from = undefined;
            canvas.classList.remove('ch-panning');
        });
    }

    private show(kind: ViewKind): void {
        this.kind = kind;
        for (const [name, button] of this.buttons) button.className = name === kind ? 'ch-on' : '';
        this.draw();
    }

    private renderExplain(text: string): void {
        this.explainBody.replaceChildren(
            ...text.split('\n').map(line => {
                const node = html('span', 'ch-line');
                node.textContent = line || ' ';
                return node;
            })
        );
    }

    private renderSummary(payload: PlanPayload): void {
        const cpuMs = payload.graph.totalCpuUs / 1000;
        const wallMs = payload.summary?.query_duration_ms ?? 0;
        const parts: Array<[string, string]> = [
            ['wall clock', wallMs ? `${wallMs} ms` : '—'],
            ['CPU', `${cpuMs.toFixed(0)} ms`],
        ];
        // Below 1 this is not parallelism, it is waiting, and saying
        // "parallelism 0.2x" would invite exactly the wrong conclusion.
        if (wallMs > 0 && cpuMs / wallMs >= 1.15) {
            parts.push(['parallelism', `${(cpuMs / wallMs).toFixed(1)}×`]);
        } else if (wallMs > 0 && cpuMs < wallMs) {
            parts.push(['mostly', 'waiting, not computing']);
        }
        if (payload.summary) {
            parts.push(
                ['rows read', formatCount(payload.summary.read_rows)],
                ['memory', formatBytes(payload.summary.memory_usage)],
                ['threads', String(payload.summary.threads)]
            );
        }

        this.summary.replaceChildren(
            ...parts.map(([label, value]) => {
                const slot = html('span');
                slot.append(`${label} `, html('b', '', value));
                return slot;
            })
        );
    }

    /**
     * What the picture means.
     *
     * Across the flame is nesting, not time, and a reader will take it for
     * time unless told otherwise — the small bars beside a join get read as
     * something that happened afterwards.
     */
    private describeView(): string {
        return this.kind === 'flame'
            ? 'Width is share of CPU time. A bar sits under the step it feeds — left to right is not time.'
            : 'Box size is share of CPU time. Arrows point from a step to the one it feeds; labels are rows.';
    }

    private draw(): void {
        if (!this.payload) return;
        this.legend.textContent = this.describeView();
        const drawing = this.kind === 'flame' ? this.drawFlame() : this.drawGraph();
        this.applyZoom(drawing);
        this.canvas.replaceChildren(this.tip, drawing);
    }

    /**
     * The drawing is laid out at its natural size and then scaled, so Fit and
     * 1:1 change nothing about the geometry — only how much of the panel it
     * takes. Fit never magnifies: a short plan blown up to fill the height
     * would be a wall of enormous bars saying nothing extra.
     */
    private applyZoom(drawing: SVGSVGElement): void {
        const naturalWidth = Number(drawing.getAttribute('width')) || 1;
        const naturalHeight = Number(drawing.getAttribute('height')) || 1;

        const scale =
            this.zoom === 'fit'
                ? Math.min(
                      1,
                      (this.canvas.clientWidth - 16) / naturalWidth,
                      (this.canvas.clientHeight - 16) / naturalHeight
                  )
                : this.zoom;

        if (!Number.isFinite(scale) || scale <= 0) return;
        this.appliedScale = scale;
        drawing.setAttribute('width', String(Math.round(naturalWidth * scale)));
        drawing.setAttribute('height', String(Math.round(naturalHeight * scale)));
    }

    /** The width the drawing is composed at, before any scaling. */
    private width(): number {
        if (this.zoom !== 'fit') return this.kind === 'flame' ? FLAME_WIDTH : GRAPH_WIDTH;
        return Math.max(MIN_CANVAS, this.canvas.clientWidth - 16);
    }

    private drawFlame(): SVGSVGElement {
        const cells = flameLayout(this.payload!.graph);
        const width = this.width();
        const depth = Math.max(...cells.map(cell => cell.depth), 0) + 1;
        const height = depth * ROW + 8;

        const svg = element('svg', { viewBox: `0 0 ${width} ${height}`, width, height });
        svg.append(this.hatchPattern());

        for (const cell of cells) {
            const x = cell.x * width;
            const w = Math.max(1, cell.width * width);
            const y = cell.depth * ROW + 4;
            svg.append(this.flameCell(cell, x, y, w));
        }
        return svg;
    }

    private flameCell(cell: FlameCell, x: number, y: number, w: number): SVGGElement {
        const group = element('g', { class: 'ch-cell' });
        const node = cell.node;

        const bar = element('rect', {
            x,
            y,
            width: w,
            height: ROW - 3,
            rx: 2,
            fill: heatColor(node.share),
            stroke: cell.id === this.selected
                ? this.palette.foreground
                : cell.bottleneck
                  ? this.palette.hot
                  : 'none',
            'stroke-width': cell.id === this.selected ? 1.5 : cell.bottleneck ? 1.5 : 0,
        });
        group.append(bar);

        // Time spent waiting is hatched rather than coloured: a step that mostly
        // waited is idle, which is a different thing from a step that was cheap.
        const waited = node.inputWaitUs + node.outputWaitUs;
        const idle = waited / (waited + node.cpuUs || 1);
        // Nearly everything in a pipeline waits on something, so idleness alone
        // marks the whole drawing. What is worth marking is a step that did
        // real work and *still* spent its life blocked — which is rare, and is
        // the only case where the hatch tells a reader something new.
        if (idle > 0.9 && node.share >= 0.05 && !cell.bottleneck && w > 6) {
            group.append(
                element('rect', {
                    x,
                    y,
                    width: w,
                    height: ROW - 3,
                    rx: 2,
                    fill: 'url(#ch-wait)',
                    opacity: 0.5,
                })
            );
        }

        const time = formatDuration(node.cpuUs);
        // The duration is only drawn on a bar wide enough to hold it, so only
        // such a bar should pay for it. Charging a narrow one for text it never
        // shows leaves a block with nothing written on it at all.
        const showTime = w > 90;
        const label = fit(node.label, showTime ? w - time.length * 6.4 : w);
        if (label) {
            const text = element('text', {
                x: x + 6,
                y: y + ROW / 2 + 1,
                fill: this.palette.foreground,
                'font-size': 11,
                'dominant-baseline': 'middle',
                class: 'ch-label',
            });
            text.textContent = label;
            group.append(text);
        }
        if (showTime) {
            const right = element('text', {
                x: x + w - 6,
                y: y + ROW / 2 + 1,
                fill: this.palette.muted,
                'font-size': 10,
                'text-anchor': 'end',
                'dominant-baseline': 'middle',
                class: 'ch-label',
            });
            right.textContent = time;
            group.append(right);
        }

        const feeds = cell.feeds
            ? `feeds ${cell.feeds.label}${cell.feeds.inputs > 1 ? ` · one of ${cell.feeds.inputs} inputs` : ''}`
            : undefined;
        this.wire(group, cell.id, node.label, node, feeds);
        return group;
    }

    private drawGraph(): SVGSVGElement {
        const laid: DagLayoutResult = dagLayout(this.payload!.graph);
        const width = this.width();
        // Tall enough that every layer gap can hold an arrowhead. Without this
        // a deep plan squeezes the gaps below the head's own length, and the
        // line and the head collapse into each other.
        const roomNeeded = laid.gapFraction > 0 ? ARROW_ROOM / laid.gapFraction : 0;
        const height = Math.max(340, laid.nodes.length * 74, roomNeeded);

        const svg = element('svg', { viewBox: `0 0 ${width} ${height}`, width, height });
        const defs = this.hatchPattern();
        defs.append(this.arrowMarker());
        svg.append(defs);

        const byId = new Map(laid.nodes.map(node => [node.id, node]));
        const busiest = Math.max(1, ...laid.edges.map(edge => edge.rows));

        for (const edge of laid.edges) {
            const from = byId.get(edge.from);
            const to = byId.get(edge.to);
            if (!from || !to) continue;

            const x1 = (from.x + from.width / 2) * width;
            const y1 = from.y * height;
            // Each edge lands on its own point across the target's lower edge,
            // so two inputs arrive side by side instead of on top of each other.
            const landing = (edge.slot + 1) / (edge.slots + 1);
            const x2 = (to.x + to.width * landing) * width;
            // The line stops short by the length of the head, which then fills
            // the gap and brings the tip to rest just clear of the box. Where
            // the gap is tighter than that, the line keeps a few pixels rather
            // than turning back on itself.
            const border = (to.y + to.height) * height;
            const y2 = Math.min(border + ARROW_GAP + ARROW, y1 - 5);
            const middle = (y1 + y2) / 2;

            // Volume is carried twice over, in weight and in strength, so the
            // heavier path still reads when several edges cross.
            const weight = Math.max(0.08, edge.rows / busiest);
            const thickness = 1 + Math.min(5, Math.log10(Math.max(1, edge.rows)) * 1.1);

            svg.append(
                element('path', {
                    d: `M ${x1} ${y1} C ${x1} ${middle}, ${x2} ${middle}, ${x2} ${y2}`,
                    fill: 'none',
                    stroke: withAlpha(this.palette.foreground, 0.2 + 0.45 * weight),
                    'stroke-width': thickness.toFixed(2),
                    'stroke-linecap': 'round',
                    'marker-end': 'url(#ch-arrow)',
                    class: 'ch-edge',
                })
            );

            if (edge.rows > 0) {
                const label = formatCount(edge.rows);
                const cx = (x1 + x2) / 2;
                // A plate behind the number, or an edge crossing it makes it
                // unreadable exactly where several edges meet.
                svg.append(
                    element('rect', {
                        x: cx - label.length * 3.1 - 3,
                        y: middle - 7,
                        width: label.length * 6.2 + 6,
                        height: 14,
                        rx: 7,
                        fill: this.palette.background,
                        opacity: 0.88,
                    })
                );
                const text = element('text', {
                    x: cx,
                    y: middle + 1,
                    fill: this.palette.muted,
                    'font-size': 9.5,
                    'text-anchor': 'middle',
                    'dominant-baseline': 'middle',
                    class: 'ch-label',
                });
                text.textContent = label;
                svg.append(text);
            }
        }

        for (const node of laid.nodes) {
            const group = element('g', { class: 'ch-cell' });
            const x = node.x * width;
            const y = node.y * height;
            const w = node.width * width;
            const h = Math.max(26, node.height * height);
            const consumers = laid.edges.filter(edge => edge.from === node.id);
            const isSink = consumers.length === 0;

            group.append(
                element('rect', {
                    x,
                    y,
                    width: w,
                    height: h,
                    rx: 3,
                    fill: heatColor(node.share),
                    stroke:
                        node.id === this.selected
                            ? this.palette.foreground
                            : node.bottleneck
                              ? this.palette.hot
                              : withAlpha(this.palette.border, 0.9),
                    'stroke-width': node.id === this.selected || node.bottleneck ? 1.5 : 1,
                })
            );

            const badge = element('text', {
                x: x + 8,
                y: y + 13,
                fill: this.palette.muted,
                'font-size': 9.5,
                class: 'ch-label',
            });
            badge.textContent = String(node.order);
            group.append(badge);

            const name = element('text', {
                x: x + w / 2,
                y: y + h / 2 - 5,
                fill: this.palette.foreground,
                'font-size': 12,
                'text-anchor': 'middle',
                class: 'ch-label',
            });
            name.textContent = fit(node.label, w);
            group.append(name);

            const detail = element('text', {
                x: x + w / 2,
                y: y + h / 2 + 11,
                fill: this.palette.muted,
                'font-size': 10,
                'text-anchor': 'middle',
                class: 'ch-label',
            });
            // Analyze runs with FORMAT Null, so the sink discards its rows and
            // reports none out. Printing that reads as "returned nothing".
            const rows = isSink ? node.inputRows : node.outputRows;
            detail.textContent = fit(
                `${formatDuration(node.cpuUs)} · ${formatCount(rows)} rows${isSink ? ' in' : ''}`,
                w
            );
            group.append(detail);

            const target = byId.get(consumers[0]?.to ?? '');
            const feeds = target
                ? `feeds ${target.label}${target.inputs.length > 1 ? ` · one of ${target.inputs.length} inputs` : ''}`
                : undefined;
            this.wire(group, node.id, node.label, node, feeds ?? 'the end of the pipeline · rows are discarded by FORMAT Null');
            svg.append(group);
        }
        return svg;
    }

    /**
     * The arrowhead every edge ends in.
     *
     * Layout already puts producers below their consumers, but "below" is a
     * convention a reader has to be told. An arrow states it.
     */
    private arrowMarker(): SVGMarkerElement {
        const marker = element('marker', {
            id: 'ch-arrow',
            viewBox: '0 0 12 10',
            // The back of the head, not the tip. The marker sits at the end of
            // the line and is drawn forward from there, so the line stops where
            // the head begins instead of running its whole length underneath
            // it and showing either side of the taper.
            refX: 0,
            refY: 5,
            markerWidth: ARROW,
            markerHeight: ARROW * 0.84,
            orient: 'auto',
            // Fixed size. Edge weight carries row volume and runs from 1 to 6,
            // so an arrowhead measured in stroke widths would swing over six
            // times its own size from one edge to the next.
            markerUnits: 'userSpaceOnUse',
        });
        marker.append(
            element('path', {
                d: 'M 0 0 L 12 5 L 0 10 L 2.6 5 Z',
                fill: withAlpha(this.palette.foreground, 0.72),
            })
        );
        return marker;
    }

    /** One diagonal hatch, reused by both drawings. */
    private hatchPattern(): SVGDefsElement {
        const defs = element('defs');
        const pattern = element('pattern', {
            id: 'ch-wait',
            width: 6,
            height: 6,
            patternUnits: 'userSpaceOnUse',
            patternTransform: 'rotate(45)',
        });
        pattern.append(
            element('rect', { width: 2, height: 6, fill: withAlpha(this.palette.background, 0.85) })
        );
        defs.append(pattern);
        return defs;
    }

    private wire(
        group: SVGGElement,
        id: string,
        label: string,
        node: { cpuUs: number; processors: number; inputRows: number; outputRows: number; inputWaitUs: number; outputWaitUs: number; outputBytes: number; description: string },
        feeds?: string
    ): void {
        group.addEventListener('mousemove', event => this.showTip(event, label, node, feeds));
        group.addEventListener('mouseleave', () => {
            this.tip.style.display = 'none';
        });
        group.addEventListener('click', () => {
            if (this.panned) {
                this.panned = false;
                return;
            }
            this.selected = this.selected === id ? undefined : id;
            this.highlightExplain(label);
            this.draw();
        });
    }

    private showTip(
        event: MouseEvent,
        label: string,
        node: { cpuUs: number; processors: number; inputRows: number; outputRows: number; inputWaitUs: number; outputWaitUs: number; outputBytes: number; description: string },
        feeds?: string
    ): void {
        const rows: Array<[string, string]> = [
            ['CPU time', formatDuration(node.cpuUs)],
            ['threads', String(node.processors)],
            ['rows in → out', `${formatCount(node.inputRows)} → ${formatCount(node.outputRows)}`],
            ['bytes out', formatBytes(node.outputBytes)],
            ['waiting', formatDuration(node.inputWaitUs + node.outputWaitUs)],
        ];

        const list = html('dl');
        for (const [term, value] of rows) {
            list.append(html('dt', '', term), html('dd', '', value));
        }

        this.tip.replaceChildren(html('div', 'ch-tip-name', label));
        if (feeds) this.tip.append(html('div', 'ch-tip-feeds', feeds));
        if (node.description) this.tip.append(html('div', '', node.description));
        this.tip.append(list);

        const bounds = this.canvas.getBoundingClientRect();
        this.tip.style.display = 'block';
        this.tip.style.left = `${Math.min(event.clientX - bounds.left + 14, bounds.width - 330)}px`;
        this.tip.style.top = `${event.clientY - bounds.top + 14}px`;
    }

    /** Selecting a step marks where the server named it in the plan text. */
    private highlightExplain(label: string): void {
        const needle = label.toLowerCase();
        let first: Element | undefined;
        for (const line of this.explainBody.querySelectorAll('.ch-line')) {
            const matched = this.selected !== undefined && (line.textContent ?? '').toLowerCase().includes(needle);
            line.classList.toggle('ch-match', matched);
            if (matched && !first) first = line;
        }
        // Only the first match is worth scrolling to; scrolling to each in turn
        // would leave the reader at the last one, which is nobody's intent.
        first?.scrollIntoView?.({ block: 'nearest' });
    }

    private async exportAs(format: ImageFormat): Promise<void> {
        const svg = this.canvas.querySelector('svg');
        if (!svg) return;

        const width = Number(svg.getAttribute('width')) || this.width();
        const height = Number(svg.getAttribute('height')) || 400;
        const options = { background: this.palette.background, width, height };
        const markup = prepareSvgForExport(svg as SVGSVGElement, options);

        const data = format === 'svg' ? markup : await rasterize(markup, format, options);
        this.transport.post({ type: 'export', format, data });
    }
}
