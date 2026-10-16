/**
 * @jest-environment jsdom
 *
 * Scale checks for the result grid.
 *
 * The plan's exit criterion is a million rows without blocking. Windowing makes
 * that a claim about constant work per render, so these measure that the cost
 * does not follow the row count.
 */
import { GridView } from '../results/view/gridView';
import { Transport } from '../results/view/transport';
import { HostMessage, ViewMessage } from '../results/protocol';
import { columnWidths, filteredIndices, sortedIndices, visibleWindow } from '../results/grid';

const COLUMNS = [
    { name: 'id', type: 'UInt64' },
    { name: 'name', type: 'String' },
    { name: 'value', type: 'Float64' },
];

function makeRows(count: number): unknown[][] {
    const rows: unknown[][] = new Array(count);
    for (let i = 0; i < count; i++) rows[i] = [String(i), `row-${i}`, i * 1.5];
    return rows;
}

function mount() {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const sent: ViewMessage[] = [];
    let handler: ((message: HostMessage) => void) | undefined;
    const transport: Transport = { post: m => sent.push(m), onMessage: fn => (handler = fn) };
    const view = new GridView(root, transport);
    const scroller = root.querySelector('.ch-scroller') as HTMLElement;
    Object.defineProperty(scroller, 'clientHeight', { value: 600, configurable: true });
    return { root, view, scroller, send: (m: HostMessage) => handler?.(m) };
}

afterEach(() => {
    document.body.innerHTML = '';
});

describe('a million rows', () => {
    const MILLION = 1_000_000;
    /** Matches the row height the grid lays out with. */
    const ROW_HEIGHT = 22;

    it('renders only a windowful, whatever the row count', () => {
        const { root, send } = mount();
        send({ type: 'begin', header: { query: 'q', profile: 'p', queryId: 'i' } });
        send({ type: 'columns', columns: COLUMNS });
        send({ type: 'rows', rows: makeRows(MILLION), total: MILLION });

        const rendered = root.querySelectorAll('.ch-body .ch-row').length;
        expect(rendered).toBeGreaterThan(0);
        // A 600px viewport at 22px per row needs about 27, plus overscan.
        expect(rendered).toBeLessThan(80);
    }, 120_000);

    it('does not spread a large batch into push, which would overflow the stack', () => {
        // `rows.push(...batch)` throws above roughly 65k arguments.
        const { send } = mount();
        send({ type: 'begin', header: { query: 'q', profile: 'p', queryId: 'i' } });
        send({ type: 'columns', columns: COLUMNS });
        expect(() => send({ type: 'rows', rows: makeRows(200_000), total: 200_000 })).not.toThrow();
    }, 120_000);

    it('scrolls a window that does not grow with the row count', () => {
        // The claim is constant work per render, so the thing to assert is the
        // window. The stopwatch this replaced measured how busy the machine
        // was: it read 4s on a loaded runner and 0.2s alone, with the same code.
        const windowsWhileScrolling = (total: number): number[] => {
            const { root, scroller, send } = mount();
            send({ type: 'begin', header: { query: 'q', profile: 'p', queryId: 'i' } });
            send({ type: 'columns', columns: COLUMNS });
            send({ type: 'rows', rows: makeRows(total), total });

            const counts: number[] = [];
            for (let i = 0; i < 20; i++) {
                scroller.scrollTop = Math.floor((i / 20) * total * ROW_HEIGHT);
                scroller.dispatchEvent(new Event('scroll'));
                counts.push(root.querySelectorAll('.ch-body .ch-row').length);
            }
            return counts;
        };

        const thousand = windowsWhileScrolling(1_000);
        const million = windowsWhileScrolling(MILLION);

        for (const rendered of [...thousand, ...million]) {
            expect(rendered).toBeGreaterThan(0);
            expect(rendered).toBeLessThan(80);
        }
        // A thousand times the rows must not cost one extra node.
        expect(Math.max(...million)).toBeLessThanOrEqual(Math.max(...thousand));
    }, 120_000);
});

describe('grid operations at scale', () => {
    const rows = makeRows(200_000);

    it('windows without touching every row', () => {
        const started = Date.now();
        for (let i = 0; i < 1000; i++) visibleWindow(1_000_000, 22, i * 1000, 600);
        expect(Date.now() - started).toBeLessThan(200);
    });

    it('samples rather than measuring every row for widths', () => {
        const started = Date.now();
        columnWidths(COLUMNS, rows);
        // Sampling means this cannot grow with the result.
        expect(Date.now() - started).toBeLessThan(100);
    });

    it('sorts a large result in reasonable time', () => {
        const started = Date.now();
        const order = sortedIndices(rows, COLUMNS, { column: 0, direction: 'desc' });
        expect(Date.now() - started).toBeLessThan(5000);
        expect(order).toHaveLength(rows.length);
        expect(rows[order[0]][0]).toBe('199999');
    }, 30_000);

    it('filters a large result in reasonable time', () => {
        const started = Date.now();
        const matches = filteredIndices(rows, COLUMNS, 'row-19999');
        expect(Date.now() - started).toBeLessThan(5000);
        expect(matches.length).toBeGreaterThan(0);
    }, 30_000);
});
