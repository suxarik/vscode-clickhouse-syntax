/**
 * Charting a two-column result.
 *
 * Scoped narrowly on purpose: a label and a number, or a time and a number.
 * That covers what the runbook queries actually return - a count per hour, a
 * size per table, a duration per query - and refuses to guess at anything else,
 * because a chart that quietly plots the wrong column is worse than no chart.
 *
 * Drawn as inline SVG with no library. The webview's content security policy
 * forbids loading one, and a bar chart is not a reason to add three hundred
 * kilobytes to a bundle.
 */
import { ColumnMeta } from '../protocol';
import { formatValue } from '../format';

const NUMERIC = /^(U?Int\d+|Float\d+|Decimal|BFloat16)/;
const TEMPORAL = /^(Date|DateTime|DateTime64)/;

function bare(type: string): string {
    let current = type.trim();
    for (;;) {
        const match = /^(?:Nullable|LowCardinality)\((.*)\)$/s.exec(current);
        if (!match) return current;
        current = match[1].trim();
    }
}

const isNumeric = (type: string) => NUMERIC.test(bare(type));
const isTemporal = (type: string) => TEMPORAL.test(bare(type));

export interface ChartPlan {
    /** Column index for the category or time axis. */
    labelColumn: number;
    /** Column index for the value axis. */
    valueColumn: number;
    kind: 'bar' | 'line';
}

/** The most rows worth drawing; beyond this a chart is a smear, not a picture. */
export const MAX_POINTS = 500;

/**
 * Decide whether this result can be charted, and how.
 *
 * Two columns, one of them numeric. A time-like first column gets a line,
 * because the order means something; anything else gets bars.
 */
export function planChart(columns: ColumnMeta[], rows: unknown[][]): ChartPlan | undefined {
    if (columns.length !== 2 || rows.length === 0) return undefined;

    const [first, second] = columns;
    if (isNumeric(second.type) && !isNumeric(first.type)) {
        return { labelColumn: 0, valueColumn: 1, kind: isTemporal(first.type) ? 'line' : 'bar' };
    }
    if (isNumeric(first.type) && !isNumeric(second.type)) {
        // `count(), name` reads the other way round and is just as common.
        return { labelColumn: 1, valueColumn: 0, kind: isTemporal(second.type) ? 'line' : 'bar' };
    }
    if (isNumeric(first.type) && isNumeric(second.type)) {
        // Two numbers: the first is the axis, as in a histogram.
        return { labelColumn: 0, valueColumn: 1, kind: 'line' };
    }
    return undefined;
}

export interface Point {
    label: string;
    value: number;
}

/** The points to draw, in row order, skipping anything that is not a number. */
export function chartPoints(columns: ColumnMeta[], rows: unknown[][], plan: ChartPlan): Point[] {
    const points: Point[] = [];
    for (const row of rows.slice(0, MAX_POINTS)) {
        const raw = row[plan.valueColumn];
        // `Number(null)` and `Number('')` are both 0, and plotting a null as
        // zero would be an outright lie about the data.
        if (raw === null || raw === undefined) continue;
        if (typeof raw === 'string' && raw.trim() === '') continue;
        const value = typeof raw === 'number' ? raw : Number(raw);
        if (!Number.isFinite(value)) continue;
        points.push({
            label: formatValue(row[plan.labelColumn], columns[plan.labelColumn].type),
            value,
        });
    }
    return points;
}

/** Round a number up to something a person would choose for an axis. */
export function niceCeiling(value: number): number {
    if (value <= 0) return 1;
    const magnitude = 10 ** Math.floor(Math.log10(value));
    for (const step of [1, 2, 2.5, 5, 10]) {
        if (value <= step * magnitude) return step * magnitude;
    }
    return 10 * magnitude;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function element<K extends keyof SVGElementTagNameMap>(
    name: K,
    attributes: Record<string, string | number>
): SVGElementTagNameMap[K] {
    const node = document.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    return node;
}

const WIDTH = 900;
const HEIGHT = 320;
const PADDING = { top: 16, right: 16, bottom: 44, left: 72 };

/**
 * Draw the chart.
 *
 * Colours come from VS Code's own variables, so it follows the theme rather
 * than being a bright rectangle in a dark editor.
 */
export function renderChart(columns: ColumnMeta[], rows: unknown[][], plan: ChartPlan): SVGSVGElement | undefined {
    const points = chartPoints(columns, rows, plan);
    if (points.length === 0) return undefined;

    const svg = element('svg', {
        viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
        preserveAspectRatio: 'none',
        class: 'ch-chart-svg',
        role: 'img',
        'aria-label': `${columns[plan.valueColumn].name} by ${columns[plan.labelColumn].name}`,
    });

    const plotWidth = WIDTH - PADDING.left - PADDING.right;
    const plotHeight = HEIGHT - PADDING.top - PADDING.bottom;
    const lowest = Math.min(0, ...points.map(point => point.value));
    const highest = Math.max(...points.map(point => point.value));
    const top = niceCeiling(highest === lowest ? highest + 1 : highest);
    const span = top - lowest || 1;
    const y = (value: number) => PADDING.top + plotHeight - ((value - lowest) / span) * plotHeight;

    // Axes and two gridlines, which is enough to read a magnitude off.
    for (const fraction of [0, 0.5, 1]) {
        const value = lowest + span * fraction;
        const at = y(value);
        svg.appendChild(
            element('line', {
                x1: PADDING.left,
                x2: WIDTH - PADDING.right,
                y1: at,
                y2: at,
                class: 'ch-chart-grid',
            })
        );
        const label = element('text', { x: PADDING.left - 8, y: at + 4, class: 'ch-chart-axis' });
        label.textContent = formatValue(value, 'Float64');
        svg.appendChild(label);
    }

    if (plan.kind === 'bar') {
        const step = plotWidth / points.length;
        const barWidth = Math.max(1, step * 0.7);
        points.forEach((point, index) => {
            const height = Math.abs(y(point.value) - y(0));
            const bar = element('rect', {
                x: PADDING.left + index * step + (step - barWidth) / 2,
                y: Math.min(y(point.value), y(0)),
                width: barWidth,
                height: Math.max(1, height),
                class: 'ch-chart-bar',
            });
            const title = document.createElementNS(SVG_NS, 'title');
            title.textContent = `${point.label}: ${point.value.toLocaleString()}`;
            bar.appendChild(title);
            svg.appendChild(bar);
        });
    } else {
        const step = points.length > 1 ? plotWidth / (points.length - 1) : 0;
        const path = points
            .map((point, index) => `${index === 0 ? 'M' : 'L'} ${PADDING.left + index * step} ${y(point.value)}`)
            .join(' ');
        svg.appendChild(element('path', { d: path, class: 'ch-chart-line' }));
    }

    // Only the ends are labelled: anything more overlaps and is unreadable.
    const first = element('text', { x: PADDING.left, y: HEIGHT - 16, class: 'ch-chart-axis' });
    first.textContent = points[0].label;
    svg.appendChild(first);
    if (points.length > 1) {
        const last = element('text', {
            x: WIDTH - PADDING.right,
            y: HEIGHT - 16,
            'text-anchor': 'end',
            class: 'ch-chart-axis',
        });
        last.textContent = points[points.length - 1].label;
        svg.appendChild(last);
    }

    return svg;
}

/** What the toolbar says when a result is charted but not all of it is. */
export function chartCaption(rows: number, points: number): string | undefined {
    if (points >= rows) return undefined;
    return `Showing the first ${points.toLocaleString()} of ${rows.toLocaleString()} rows.`;
}
