/**
 * @jest-environment jsdom
 *
 * Tests for the result grid's DOM behaviour.
 */
import { GridView } from '../results/view/gridView';
import { Transport } from '../results/view/transport';
import { HostMessage, ViewMessage } from '../results/protocol';

/** A transport that records what the view sends and lets tests push messages. */
function makeTransport() {
    const sent: ViewMessage[] = [];
    let handler: ((message: HostMessage) => void) | undefined;
    const transport: Transport = {
        post: message => sent.push(message),
        onMessage: fn => {
            handler = fn;
        },
    };
    return {
        transport,
        sent,
        send: (message: HostMessage) => handler?.(message),
    };
}

function mount() {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const harness = makeTransport();
    const view = new GridView(root, harness.transport);
    // jsdom reports zero height, so give the scroller a viewport to window against.
    const scroller = root.querySelector('.ch-scroller') as HTMLElement;
    Object.defineProperty(scroller, 'clientHeight', { value: 440, configurable: true });
    return { root, view, scroller, ...harness };
}

const HEADER = {
    query: 'SELECT id, name FROM events',
    profile: 'local',
    queryId: 'q1',
    columns: [
        { name: 'id', type: 'UInt64' },
        { name: 'name', type: 'String' },
    ],
};

function cellTexts(root: HTMLElement): string[][] {
    return [...root.querySelectorAll('.ch-body .ch-row')].map(row =>
        [...row.querySelectorAll('.ch-cell')].slice(1).map(cell => cell.textContent ?? '')
    );
}

afterEach(() => {
    document.body.innerHTML = '';
});

describe('lifecycle', () => {
    it('announces readiness so the host can start sending', () => {
        const { sent } = mount();
        expect(sent).toEqual([{ type: 'ready' }]);
    });

    it('renders the column headers', () => {
        const { root, send } = mount();
        send({ type: 'begin', header: HEADER });
        const headers = [...root.querySelectorAll('.ch-head .ch-header-cell')].map(cell => cell.textContent);
        expect(headers).toEqual(['id', 'name']);
    });

    it('renders rows as they arrive', () => {
        const { root, send } = mount();
        send({ type: 'begin', header: HEADER });
        send({ type: 'rows', rows: [['1', 'alpha']], total: 1 });
        expect(cellTexts(root)).toEqual([['1', 'alpha']]);

        send({ type: 'rows', rows: [['2', 'beta']], total: 2 });
        expect(cellTexts(root)).toEqual([
            ['1', 'alpha'],
            ['2', 'beta'],
        ]);
    });

    it('shows an error instead of rows', () => {
        const { root, send } = mount();
        send({ type: 'begin', header: HEADER });
        send({ type: 'error', message: 'Table does not exist', code: 60 });
        const message = root.querySelector('.ch-message') as HTMLElement;
        expect(message.hidden).toBe(false);
        expect(message.textContent).toContain('Table does not exist');
        expect(message.textContent).toContain('60');
    });

    it('reports cancellation', () => {
        const { root, send } = mount();
        send({ type: 'begin', header: HEADER });
        send({ type: 'cancelled' });
        expect((root.querySelector('.ch-message') as HTMLElement).textContent).toContain('cancelled');
    });

    it('offers Cancel only while running', () => {
        const { root, send } = mount();
        const cancel = root.querySelector('.ch-cancel') as HTMLButtonElement;
        expect(cancel.hidden).toBe(true);

        send({ type: 'begin', header: HEADER });
        expect(cancel.hidden).toBe(false);

        send({ type: 'end', statistics: {}, truncated: false });
        expect(cancel.hidden).toBe(true);
    });

    it('clears the previous result when a new query begins', () => {
        const { root, send } = mount();
        send({ type: 'begin', header: HEADER });
        send({ type: 'rows', rows: [['1', 'alpha']], total: 1 });
        send({ type: 'begin', header: HEADER });
        expect(cellTexts(root)).toEqual([]);
    });
});

describe('cells', () => {
    it('marks NULL distinctly rather than showing an empty cell', () => {
        const { root, send } = mount();
        send({ type: 'begin', header: HEADER });
        send({ type: 'rows', rows: [['1', null]], total: 1 });
        const nullCell = root.querySelector('.ch-body .is-null');
        expect(nullCell?.textContent).toBe('NULL');
    });

    it('right-aligns numeric columns', () => {
        const { root, send } = mount();
        send({ type: 'begin', header: HEADER });
        send({ type: 'rows', rows: [['1', 'alpha']], total: 1 });
        const cells = [...root.querySelectorAll('.ch-body .ch-cell')].slice(1);
        expect(cells[0].classList.contains('is-numeric')).toBe(true);
        expect(cells[1].classList.contains('is-numeric')).toBe(false);
    });

    it('keeps a large UInt64 exact', () => {
        const { root, send } = mount();
        send({ type: 'begin', header: HEADER });
        send({ type: 'rows', rows: [['18446744073709551615', 'x']], total: 1 });
        expect(cellTexts(root)[0][0]).toBe('18446744073709551615');
    });

    it('expands a composite cell on click', () => {
        const { root, send } = mount();
        send({
            type: 'begin',
            header: { ...HEADER, columns: [{ name: 'tags', type: 'Array(String)' }] },
        });
        send({ type: 'rows', rows: [[['a', 'b']]], total: 1 });

        const cell = root.querySelector('.ch-body .is-composite') as HTMLElement;
        expect(cell.textContent).toBe('[a, b]');
        cell.click();

        const detail = root.querySelector('.ch-detail-body');
        expect(detail?.textContent).toBe('[\n  "a",\n  "b"\n]');
    });

    it('numbers the rows', () => {
        const { root, send } = mount();
        send({ type: 'begin', header: HEADER });
        send({ type: 'rows', rows: [['1', 'a'], ['2', 'b']], total: 2 });
        const gutters = [...root.querySelectorAll('.ch-body .ch-gutter')].map(cell => cell.textContent);
        expect(gutters).toEqual(['1', '2']);
    });
});

describe('sorting', () => {
    function sortedNames(root: HTMLElement): string[] {
        return cellTexts(root).map(row => row[1]);
    }

    it('cycles ascending, descending and back on header clicks', () => {
        const { root, send } = mount();
        send({ type: 'begin', header: HEADER });
        send({ type: 'rows', rows: [['2', 'beta'], ['1', 'alpha'], ['3', 'gamma']], total: 3 });

        // The header is rebuilt when the sort changes, so re-query it each time.
        const header = () => root.querySelector('.ch-head [data-column="0"]') as HTMLElement;
        header().click();
        expect(sortedNames(root)).toEqual(['alpha', 'beta', 'gamma']);

        header().click();
        expect(sortedNames(root)).toEqual(['gamma', 'beta', 'alpha']);

        header().click();
        expect(sortedNames(root)).toEqual(['beta', 'alpha', 'gamma']);
    });

    it('marks the sorted column', () => {
        const { root, send } = mount();
        send({ type: 'begin', header: HEADER });
        send({ type: 'rows', rows: [['1', 'a']], total: 1 });
        (root.querySelector('.ch-head [data-column="0"]') as HTMLElement).click();
        expect((root.querySelector('.ch-head [data-column="0"]') as HTMLElement).textContent).toContain('▲');
    });
});

describe('filtering', () => {
    it('narrows to matching rows', () => {
        const { root, send } = mount();
        send({ type: 'begin', header: HEADER });
        send({ type: 'rows', rows: [['1', 'alpha'], ['2', 'beta']], total: 2 });

        const filter = root.querySelector('.ch-filter') as HTMLInputElement;
        filter.value = 'beta';
        filter.dispatchEvent(new Event('input'));

        expect(cellTexts(root)).toEqual([['2', 'beta']]);
    });

    it('restores every row when cleared', () => {
        const { root, send } = mount();
        send({ type: 'begin', header: HEADER });
        send({ type: 'rows', rows: [['1', 'alpha'], ['2', 'beta']], total: 2 });

        const filter = root.querySelector('.ch-filter') as HTMLInputElement;
        filter.value = 'beta';
        filter.dispatchEvent(new Event('input'));
        filter.value = '';
        filter.dispatchEvent(new Event('input'));

        expect(cellTexts(root)).toHaveLength(2);
    });
});

describe('footer', () => {
    it('counts rows and reports timing', () => {
        const { root, send } = mount();
        send({ type: 'begin', header: HEADER });
        send({ type: 'rows', rows: [['1', 'a'], ['2', 'b']], total: 2 });
        send({ type: 'end', statistics: { elapsedMs: 1500, readRows: 1000, readBytes: 2048 }, truncated: false });

        const footer = root.querySelector('.ch-footer')?.textContent ?? '';
        expect(footer).toContain('2 rows');
        expect(footer).toContain('1.50 s');
        expect(footer).toContain('1.00 K rows');
        expect(footer).toContain('2.00 KiB');
        expect(footer).toContain('local');
    });

    it('says when a result was cut short', () => {
        const { root, send } = mount();
        send({ type: 'begin', header: HEADER });
        send({ type: 'rows', rows: [['1', 'a']], total: 1 });
        send({ type: 'end', statistics: {}, truncated: true });
        expect(root.querySelector('.ch-footer')?.textContent).toContain('truncated');
    });

    it('says how many rows a filter is hiding', () => {
        const { root, send } = mount();
        send({ type: 'begin', header: HEADER });
        send({ type: 'rows', rows: [['1', 'alpha'], ['2', 'beta']], total: 2 });
        const filter = root.querySelector('.ch-filter') as HTMLInputElement;
        filter.value = 'beta';
        filter.dispatchEvent(new Event('input'));
        expect(root.querySelector('.ch-footer')?.textContent).toContain('of 2');
    });
});

describe('actions', () => {
    it('asks the host to cancel', () => {
        const { root, send, sent } = mount();
        send({ type: 'begin', header: HEADER });
        (root.querySelector('.ch-cancel') as HTMLButtonElement).click();
        expect(sent).toContainEqual({ type: 'cancel' });
    });

    it('asks the host to copy in the chosen format', () => {
        const { root, sent } = mount();
        (root.querySelector('[data-action="copy"][data-format="csv"]') as HTMLElement).click();
        expect(sent).toContainEqual({ type: 'copy', format: 'csv', scope: 'all' });
    });

    it('asks the host to export', () => {
        const { root, sent } = mount();
        (root.querySelector('[data-action="export"][data-format="json"]') as HTMLElement).click();
        expect(sent).toContainEqual({ type: 'export', format: 'json' });
    });
});

describe('windowing', () => {
    it('renders only the visible slice of a large result', () => {
        const { root, send } = mount();
        send({ type: 'begin', header: HEADER });
        send({
            type: 'rows',
            rows: Array.from({ length: 50_000 }, (_, i) => [String(i), `row-${i}`]),
            total: 50_000,
        });

        const rendered = root.querySelectorAll('.ch-body .ch-row').length;
        expect(rendered).toBeGreaterThan(0);
        // A viewport of 440px at 22px per row cannot need anything like 50k rows.
        expect(rendered).toBeLessThan(100);
    });

    it('sizes the spacer to the whole result', () => {
        const { root, send } = mount();
        send({ type: 'begin', header: HEADER });
        send({ type: 'rows', rows: Array.from({ length: 1000 }, (_, i) => [String(i), 'x']), total: 1000 });
        expect((root.querySelector('.ch-spacer') as HTMLElement).style.height).toBe('22000px');
    });

    it('renders a different slice after scrolling', () => {
        const { root, scroller, send } = mount();
        send({ type: 'begin', header: HEADER });
        send({ type: 'rows', rows: Array.from({ length: 5000 }, (_, i) => [String(i), `row-${i}`]), total: 5000 });

        const before = cellTexts(root)[0][1];
        scroller.scrollTop = 22_000;
        scroller.dispatchEvent(new Event('scroll'));

        expect(cellTexts(root)[0][1]).not.toBe(before);
        expect((root.querySelector('.ch-table') as HTMLElement).style.transform).toContain('translateY');
    });
});
