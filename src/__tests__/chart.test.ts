/**
 * @jest-environment jsdom
 *
 * Tests for charting a result.
 *
 * The rule worth defending is the refusal: a chart that quietly plots the wrong
 * column is worse than no chart, so most of these check that the offer is
 * withheld rather than that the drawing is pretty.
 */
import { GridView } from '../results/view/gridView';
import { Transport } from '../results/view/transport';
import { HostMessage, ViewMessage } from '../results/protocol';
import { chartCaption, chartPoints, MAX_POINTS, niceCeiling, planChart, renderChart } from '../results/view/chart';

const column = (name: string, type: string) => ({ name, type });

describe('deciding whether to chart', () => {
    it('charts a label and a count as bars', () => {
        expect(planChart([column('table', 'String'), column('n', 'UInt64')], [['a', '1']])).toEqual({
            labelColumn: 0,
            valueColumn: 1,
            kind: 'bar',
        });
    });

    it('charts a time series as a line, because the order means something', () => {
        expect(planChart([column('hour', 'DateTime'), column('n', 'UInt64')], [['x', '1']])?.kind).toBe('line');
        expect(planChart([column('d', 'Date'), column('n', 'Float64')], [['x', '1']])?.kind).toBe('line');
    });

    it('reads the columns the other way round when that is how they came', () => {
        // `SELECT count(), table` is just as common as the reverse.
        expect(planChart([column('n', 'UInt64'), column('table', 'String')], [['1', 'a']])).toEqual({
            labelColumn: 1,
            valueColumn: 0,
            kind: 'bar',
        });
    });

    it('sees through Nullable and LowCardinality', () => {
        expect(
            planChart([column('t', 'LowCardinality(String)'), column('n', 'Nullable(UInt64)')], [['a', '1']])
        ).toBeDefined();
    });

    it('refuses anything but two columns', () => {
        expect(planChart([column('n', 'UInt64')], [['1']])).toBeUndefined();
        expect(
            planChart([column('a', 'String'), column('b', 'UInt64'), column('c', 'UInt64')], [['a', '1', '2']])
        ).toBeUndefined();
    });

    it('refuses two columns with nothing numeric in them', () => {
        expect(planChart([column('a', 'String'), column('b', 'String')], [['x', 'y']])).toBeUndefined();
    });

    it('refuses an empty result', () => {
        expect(planChart([column('a', 'String'), column('b', 'UInt64')], [])).toBeUndefined();
    });
});

describe('the points', () => {
    const columns = [column('name', 'String'), column('n', 'UInt64')];
    const plan = { labelColumn: 0, valueColumn: 1, kind: 'bar' as const };

    it('reads numbers that arrived as strings, which 64-bit ones do', () => {
        expect(chartPoints(columns, [['a', '9007199254740993']], plan)[0].value).toBeCloseTo(9007199254740993);
    });

    it('skips a row whose value is not a number rather than plotting zero', () => {
        expect(chartPoints(columns, [['a', '1'], ['b', null], ['c', 'x'], ['d', '2']], plan)).toHaveLength(2);
    });

    it('stops at a readable number of points', () => {
        const rows = Array.from({ length: MAX_POINTS + 100 }, (_, i) => [`r${i}`, String(i)]);
        expect(chartPoints(columns, rows, plan)).toHaveLength(MAX_POINTS);
    });

    it('says so when it is only showing part of the result', () => {
        expect(chartCaption(1000, 500)).toContain('first 500');
        expect(chartCaption(1000, 500)).toContain('1,000');
        expect(chartCaption(20, 20)).toBeUndefined();
    });
});

describe('the axis', () => {
    it('rounds up to a number a person would pick', () => {
        expect(niceCeiling(7)).toBe(10);
        expect(niceCeiling(1.5)).toBe(2);
        expect(niceCeiling(23)).toBe(25);
        expect(niceCeiling(1000)).toBe(1000);
        expect(niceCeiling(0)).toBe(1);
        expect(niceCeiling(-5)).toBe(1);
    });
});

describe('drawing', () => {
    const columns = [column('name', 'String'), column('n', 'UInt64')];

    it('draws one bar per row', () => {
        const svg = renderChart(columns, [['a', '1'], ['b', '2'], ['c', '3']], {
            labelColumn: 0,
            valueColumn: 1,
            kind: 'bar',
        })!;
        expect(svg.querySelectorAll('rect.ch-chart-bar')).toHaveLength(3);
        // Every bar names its value, so the picture is not the only reading.
        expect(svg.querySelector('rect title')?.textContent).toBe('a: 1');
    });

    it('draws a line as a single path', () => {
        const svg = renderChart(columns, [['a', '1'], ['b', '5']], {
            labelColumn: 0,
            valueColumn: 1,
            kind: 'line',
        })!;
        expect(svg.querySelectorAll('path.ch-chart-line')).toHaveLength(1);
        expect(svg.querySelector('path')?.getAttribute('d')).toMatch(/^M .* L /);
    });

    it('labels only the ends, so the axis stays readable', () => {
        const rows = Array.from({ length: 50 }, (_, i) => [`row-${i}`, String(i)]);
        const svg = renderChart(columns, rows, { labelColumn: 0, valueColumn: 1, kind: 'bar' })!;
        const labels = [...svg.querySelectorAll('text')].map(node => node.textContent);
        expect(labels).toContain('row-0');
        expect(labels).toContain('row-49');
        expect(labels).not.toContain('row-25');
    });

    it('describes itself for a screen reader', () => {
        const svg = renderChart(columns, [['a', '1']], { labelColumn: 0, valueColumn: 1, kind: 'bar' })!;
        expect(svg.getAttribute('aria-label')).toBe('n by name');
    });

    it('draws nothing when no row has a usable number', () => {
        expect(
            renderChart(columns, [['a', null], ['b', 'x']], { labelColumn: 0, valueColumn: 1, kind: 'bar' })
        ).toBeUndefined();
    });

    it('survives every row having the same value', () => {
        // A zero-height range would divide by zero if it were not handled.
        const svg = renderChart(columns, [['a', '5'], ['b', '5']], {
            labelColumn: 0,
            valueColumn: 1,
            kind: 'bar',
        })!;
        for (const rect of svg.querySelectorAll('rect')) {
            expect(Number(rect.getAttribute('height'))).toBeGreaterThan(0);
        }
    });
});

describe('the chart toggle in the grid', () => {
    function mount(columns: { name: string; type: string }[], rows: unknown[][]) {
        const root = document.createElement('div');
        document.body.appendChild(root);
        let deliver: ((message: HostMessage) => void) | undefined;
        const transport: Transport = {
            post(message: ViewMessage) {
                if (message.type !== 'ready') return;
                deliver?.({ type: 'begin', header: { query: 'q', profile: 'p', queryId: 'i' } });
                deliver?.({ type: 'columns', columns });
                deliver?.({ type: 'rows', rows, total: rows.length });
                deliver?.({ type: 'end', statistics: {}, truncated: false });
            },
            onMessage(handler) {
                deliver = handler;
            },
        };
        new GridView(root, transport);
        return root;
    }

    beforeEach(() => document.body.replaceChildren());

    it('offers the toggle only when there is something to chart', () => {
        const chartable = mount([column('t', 'String'), column('n', 'UInt64')], [['a', '1']]);
        expect(chartable.querySelector<HTMLElement>('.ch-chart-toggle')!.hidden).toBe(false);

        const notChartable = mount([column('a', 'String'), column('b', 'String')], [['x', 'y']]);
        expect(notChartable.querySelector<HTMLElement>('.ch-chart-toggle')!.hidden).toBe(true);
    });

    it('swaps the rows for the chart and back', () => {
        const root = mount([column('t', 'String'), column('n', 'UInt64')], [['a', '1'], ['b', '2']]);
        const button = root.querySelector<HTMLButtonElement>('.ch-chart-toggle')!;

        button.click();
        expect(root.querySelector<HTMLElement>('.ch-chart')!.hidden).toBe(false);
        expect(root.querySelector<HTMLElement>('.ch-scroller')!.hidden).toBe(true);
        expect(root.querySelectorAll('rect.ch-chart-bar')).toHaveLength(2);
        expect(button.textContent).toBe('Rows');

        button.click();
        expect(root.querySelector<HTMLElement>('.ch-chart')!.hidden).toBe(true);
        expect(root.querySelector<HTMLElement>('.ch-scroller')!.hidden).toBe(false);
        expect(button.textContent).toBe('Chart');
    });

    it('charts what the filter left, not the whole result', () => {
        const root = mount([column('t', 'String'), column('n', 'UInt64')], [['keep', '1'], ['drop', '2']]);
        const filter = root.querySelector<HTMLInputElement>('.ch-filter')!;
        filter.value = 'keep';
        filter.dispatchEvent(new Event('input'));
        root.querySelector<HTMLButtonElement>('.ch-chart-toggle')!.click();

        expect(root.querySelectorAll('rect.ch-chart-bar')).toHaveLength(1);
        expect(root.querySelector('rect title')?.textContent).toBe('keep: 1');
    });
});
