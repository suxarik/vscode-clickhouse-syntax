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

const HEADER = { query: 'SELECT id, name FROM events', profile: 'local', queryId: 'q1' };

const COLUMNS = [
    { name: 'id', type: 'UInt64' },
    { name: 'name', type: 'String' },
];

/** The message order the runner produces: begin, then columns, then rows. */
function start(send: (message: HostMessage) => void, columns = COLUMNS): void {
    send({ type: 'begin', header: HEADER });
    send({ type: 'columns', columns });
}

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
        start(send);
        const headers = [...root.querySelectorAll('.ch-head .ch-header-cell')].map(cell => cell.textContent);
        expect(headers).toEqual(['id', 'name']);
    });

    it('renders rows as they arrive', () => {
        const { root, send } = mount();
        start(send);
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
        start(send);
        send({ type: 'error', message: 'Table does not exist', code: 60 });
        const message = root.querySelector('.ch-message') as HTMLElement;
        expect(message.hidden).toBe(false);
        expect(message.textContent).toContain('Table does not exist');
        expect(message.textContent).toContain('60');
    });

    it('reports cancellation', () => {
        const { root, send } = mount();
        start(send);
        send({ type: 'cancelled' });
        expect((root.querySelector('.ch-message') as HTMLElement).textContent).toContain('cancelled');
    });

    it('offers Cancel only while running', () => {
        const { root, send } = mount();
        const cancel = root.querySelector('.ch-cancel') as HTMLButtonElement;
        expect(cancel.hidden).toBe(true);

        start(send);
        expect(cancel.hidden).toBe(false);

        send({ type: 'end', statistics: {}, truncated: false });
        expect(cancel.hidden).toBe(true);
    });

    it('clears the previous result when a new query begins', () => {
        const { root, send } = mount();
        start(send);
        send({ type: 'rows', rows: [['1', 'alpha']], total: 1 });
        start(send);
        expect(cellTexts(root)).toEqual([]);
    });
});

describe('cells', () => {
    it('marks NULL distinctly rather than showing an empty cell', () => {
        const { root, send } = mount();
        start(send);
        send({ type: 'rows', rows: [['1', null]], total: 1 });
        const nullCell = root.querySelector('.ch-body .is-null');
        expect(nullCell?.textContent).toBe('NULL');
    });

    it('right-aligns numeric columns', () => {
        const { root, send } = mount();
        start(send);
        send({ type: 'rows', rows: [['1', 'alpha']], total: 1 });
        const cells = [...root.querySelectorAll('.ch-body .ch-cell')].slice(1);
        expect(cells[0].classList.contains('is-numeric')).toBe(true);
        expect(cells[1].classList.contains('is-numeric')).toBe(false);
    });

    it('keeps a large UInt64 exact', () => {
        const { root, send } = mount();
        start(send);
        send({ type: 'rows', rows: [['18446744073709551615', 'x']], total: 1 });
        expect(cellTexts(root)[0][0]).toBe('18446744073709551615');
    });

    it('expands a composite cell on click', () => {
        const { root, send } = mount();
        start(send, [{ name: 'tags', type: 'Array(String)' }]);
        send({ type: 'rows', rows: [[['a', 'b']]], total: 1 });

        const cell = root.querySelector('.ch-body .is-composite') as HTMLElement;
        expect(cell.textContent).toBe('[a, b]');
        cell.click();

        const detail = root.querySelector('.ch-detail-body');
        expect(detail?.textContent).toBe('[\n  "a",\n  "b"\n]');
    });

    it('numbers the rows', () => {
        const { root, send } = mount();
        start(send);
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
        start(send);
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
        start(send);
        send({ type: 'rows', rows: [['1', 'a']], total: 1 });
        (root.querySelector('.ch-head [data-column="0"]') as HTMLElement).click();
        expect((root.querySelector('.ch-head [data-column="0"]') as HTMLElement).textContent).toContain('▲');
    });
});

describe('filtering', () => {
    it('narrows to matching rows', () => {
        const { root, send } = mount();
        start(send);
        send({ type: 'rows', rows: [['1', 'alpha'], ['2', 'beta']], total: 2 });

        const filter = root.querySelector('.ch-filter') as HTMLInputElement;
        filter.value = 'beta';
        filter.dispatchEvent(new Event('input'));

        expect(cellTexts(root)).toEqual([['2', 'beta']]);
    });

    it('restores every row when cleared', () => {
        const { root, send } = mount();
        start(send);
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
        start(send);
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
        start(send);
        send({ type: 'rows', rows: [['1', 'a']], total: 1 });
        send({ type: 'end', statistics: {}, truncated: true });
        expect(root.querySelector('.ch-footer')?.textContent).toContain('truncated');
    });

    it('says how many rows a filter is hiding', () => {
        const { root, send } = mount();
        start(send);
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
        start(send);
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
        start(send);
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
        start(send);
        send({ type: 'rows', rows: Array.from({ length: 1000 }, (_, i) => [String(i), 'x']), total: 1000 });
        expect((root.querySelector('.ch-spacer') as HTMLElement).style.height).toBe('22000px');
    });

    it('renders a different slice after scrolling', () => {
        const { root, scroller, send } = mount();
        start(send);
        send({ type: 'rows', rows: Array.from({ length: 5000 }, (_, i) => [String(i), `row-${i}`]), total: 5000 });

        const before = cellTexts(root)[0][1];
        scroller.scrollTop = 22_000;
        scroller.dispatchEvent(new Event('scroll'));

        expect(cellTexts(root)[0][1]).not.toBe(before);
        expect((root.querySelector('.ch-table') as HTMLElement).style.transform).toContain('translateY');
    });
});

describe('columns arriving after rows', () => {
    it('keeps rows that streamed in before the columns were known', () => {
        // The client learns the column names from the stream, so rows can reach
        // the view first. Losing them here was what made results look empty.
        const { root, send } = mount();
        send({ type: 'begin', header: HEADER });
        send({ type: 'rows', rows: [['1', 'alpha']], total: 1 });
        send({ type: 'columns', columns: COLUMNS });
        send({ type: 'rows', rows: [['2', 'beta']], total: 2 });

        expect(cellTexts(root)).toEqual([
            ['1', 'alpha'],
            ['2', 'beta'],
        ]);
        expect([...root.querySelectorAll('.ch-head .ch-header-cell')].map(c => c.textContent)).toEqual([
            'id',
            'name',
        ]);
    });

    it('renders rows once, not twice', () => {
        const { root, send } = mount();
        start(send);
        send({ type: 'rows', rows: [['1', 'a'], ['2', 'b']], total: 2 });
        send({ type: 'end', statistics: {}, truncated: false });
        expect(cellTexts(root)).toHaveLength(2);
        expect(root.querySelector('.ch-footer')?.textContent).toContain('2 rows');
    });
});

describe('horizontal scrolling', () => {
    it('keeps the header aligned with the columns beneath it', () => {
        // The header is outside the scroller so it survives vertical scrolling;
        // horizontally it has to follow, or labels sit over the wrong values.
        const { root, scroller, send } = mount();
        start(send);
        send({ type: 'rows', rows: [['1', 'alpha']], total: 1 });

        const head = root.querySelector('.ch-head') as HTMLElement;
        expect(head.scrollLeft).toBe(0);

        scroller.scrollLeft = 250;
        scroller.dispatchEvent(new Event('scroll'));
        expect(head.scrollLeft).toBe(250);
    });

    it('keeps them aligned when rows re-render', () => {
        const { root, scroller, send } = mount();
        start(send);
        send({ type: 'rows', rows: [['1', 'a']], total: 1 });

        scroller.scrollLeft = 120;
        scroller.dispatchEvent(new Event('scroll'));
        send({ type: 'rows', rows: [['2', 'b']], total: 2 });

        expect((root.querySelector('.ch-head') as HTMLElement).scrollLeft).toBe(120);
    });
});

describe('column alignment', () => {
    /** Widths as applied to a row's cells, ignoring the gutter. */
    function widthsOf(root: HTMLElement, selector: string): string[] {
        const row = root.querySelector(selector);
        return [...(row?.querySelectorAll('.ch-cell') ?? [])].slice(1).map(c => (c as HTMLElement).style.width);
    }

    it('gives header and body cells the same widths', () => {
        // Sized independently, a wide value widens its body cell but not its
        // header, so the columns drift apart as you scroll across.
        const { root, send } = mount();
        start(send);
        send({ type: 'rows', rows: [['1', 'a-fairly-long-value']], total: 1 });

        const head = widthsOf(root, '.ch-head .ch-row');
        const body = widthsOf(root, '.ch-body .ch-row');
        expect(head).toEqual(body);
        // Pixels, because the padding and border that come out of the content
        // box are in pixels too - sizing in `ch` left every column a couple of
        // characters short of what it holds.
        expect(head.every(width => width.endsWith('px'))).toBe(true);
    });

    it('does not resize columns as more rows stream in', () => {
        const { root, send } = mount();
        start(send);
        send({ type: 'rows', rows: [['1', 'short']], total: 1 });
        const before = widthsOf(root, '.ch-head .ch-row');

        send({ type: 'rows', rows: [['2', 'a-much-much-longer-value']], total: 2 });
        expect(widthsOf(root, '.ch-head .ch-row')).toEqual(before);
    });

    it('keeps widths matched after sorting', () => {
        const { root, send } = mount();
        start(send);
        send({ type: 'rows', rows: [['2', 'b'], ['1', 'a']], total: 2 });
        (root.querySelector('.ch-head [data-column="0"]') as HTMLElement).click();

        expect(widthsOf(root, '.ch-head .ch-row')).toEqual(widthsOf(root, '.ch-body .ch-row'));
    });
});

describe('column widths', () => {
    /** A pointer event jsdom can dispatch, with the fields the view reads. */
    function pointer(type: string, clientX: number): Event {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.assign(event, { clientX, pointerId: 1 });
        return event;
    }

    const widthPx = (root: HTMLElement, index: number) =>
        parseFloat(
            (root.querySelectorAll<HTMLElement>('.ch-head .ch-header-cell')[index] as HTMLElement).style.width
        );

    it('leaves room for the padding and border, not just the characters', () => {
        // `box-sizing: border-box` takes the 8px padding either side and the
        // 1px border out of the content box, so a column sized purely by its
        // character count truncates a couple of characters early.
        const { root, send } = mount();
        start(send);
        send({ type: 'rows', rows: [['1', 'abcdefghij']], total: 1 });

        // Ten characters of content, plus the chrome.
        expect(widthPx(root, 1)).toBeGreaterThan(10 * 7);
    });

    it('offers a resize handle on every column', () => {
        const { root, send } = mount();
        start(send);
        send({ type: 'rows', rows: [['1', 'a']], total: 1 });
        expect(root.querySelectorAll('.ch-resizer')).toHaveLength(COLUMNS.length);
    });

    it('widens a column as it is dragged, and keeps the body in step', () => {
        const { root, send } = mount();
        start(send);
        send({ type: 'rows', rows: [['1', 'a']], total: 1 });

        const before = widthPx(root, 1);
        const resizer = root.querySelectorAll<HTMLElement>('.ch-resizer')[1];
        resizer.dispatchEvent(pointer('pointerdown', 100));
        resizer.dispatchEvent(pointer('pointermove', 180));
        resizer.dispatchEvent(pointer('pointerup', 180));

        expect(widthPx(root, 1)).toBe(before + 80);
        // Header and body must not drift apart.
        const head = [...root.querySelectorAll<HTMLElement>('.ch-head .ch-header-cell')].map(c => c.style.width);
        const body = [...root.querySelectorAll<HTMLElement>('.ch-body .ch-row:first-child .ch-cell')]
            .slice(1)
            .map(c => c.style.width);
        expect(body).toEqual(head);
    });

    it('will not let a column be dragged away to nothing', () => {
        const { root, send } = mount();
        start(send);
        send({ type: 'rows', rows: [['1', 'a']], total: 1 });

        const resizer = root.querySelectorAll<HTMLElement>('.ch-resizer')[1];
        resizer.dispatchEvent(pointer('pointerdown', 300));
        resizer.dispatchEvent(pointer('pointermove', -5000));
        resizer.dispatchEvent(pointer('pointerup', -5000));

        expect(widthPx(root, 1)).toBeGreaterThan(0);
    });

    it('does not sort the column the drag ended on', () => {
        // A drag ends with a click on the header; sorting then would be a
        // surprise every single time someone resized something.
        const { root, send } = mount();
        start(send);
        send({ type: 'rows', rows: [['2', 'b'], ['1', 'a']], total: 2 });
        const firstCell = () => root.querySelector('.ch-body .ch-cell:not(.ch-gutter)')?.textContent;
        const before = firstCell();

        const resizer = root.querySelectorAll<HTMLElement>('.ch-resizer')[0];
        resizer.dispatchEvent(pointer('pointerdown', 100));
        resizer.dispatchEvent(pointer('pointermove', 140));
        resizer.dispatchEvent(pointer('pointerup', 140));
        root.querySelectorAll<HTMLElement>('.ch-header-cell')[0].dispatchEvent(
            new MouseEvent('click', { bubbles: true })
        );

        expect(firstCell()).toBe(before);
    });

    it('still sorts when the header itself is clicked', () => {
        const { root, send } = mount();
        start(send);
        send({ type: 'rows', rows: [['2', 'b'], ['1', 'a']], total: 2 });

        root.querySelectorAll<HTMLElement>('.ch-header-cell')[0].dispatchEvent(
            new MouseEvent('click', { bubbles: true })
        );
        expect(root.querySelector('.ch-body .ch-cell:not(.ch-gutter)')?.textContent).toBe('1');
    });

    it('keeps a hand-set width when more rows arrive', () => {
        // Re-measuring would undo what the reader just did.
        const { root, send } = mount();
        start(send);
        send({ type: 'rows', rows: [['1', 'a']], total: 1 });

        const resizer = root.querySelectorAll<HTMLElement>('.ch-resizer')[1];
        resizer.dispatchEvent(pointer('pointerdown', 100));
        resizer.dispatchEvent(pointer('pointermove', 200));
        resizer.dispatchEvent(pointer('pointerup', 200));
        const chosen = widthPx(root, 1);

        send({ type: 'rows', rows: [['2', 'a-much-longer-value-than-before']], total: 2 });
        expect(widthPx(root, 1)).toBe(chosen);
    });

    it('keeps the dragged element alive for the whole drag', () => {
        // Re-rendering the header mid-drag would remove the element the pointer
        // is captured on, and the drag would die after its first movement.
        const { root, send } = mount();
        start(send);
        send({ type: 'rows', rows: [['1', 'a']], total: 1 });

        const resizer = root.querySelectorAll<HTMLElement>('.ch-resizer')[1];
        resizer.dispatchEvent(pointer('pointerdown', 100));
        resizer.dispatchEvent(pointer('pointermove', 140));
        expect(resizer.isConnected).toBe(true);
        resizer.dispatchEvent(pointer('pointermove', 200));
        resizer.dispatchEvent(pointer('pointerup', 200));

        // Every movement counted, not just the first.
        expect(widthPx(root, 1)).toBe(parseFloat(resizer.parentElement!.style.width));
    });

    it('fits a column to its contents on a double-click', () => {
        const { root, send } = mount();
        start(send);
        send({ type: 'rows', rows: [['1', 'a']], total: 1 });

        const drag = root.querySelectorAll<HTMLElement>('.ch-resizer')[1];
        drag.dispatchEvent(pointer('pointerdown', 100));
        drag.dispatchEvent(pointer('pointermove', 400));
        drag.dispatchEvent(pointer('pointerup', 400));
        const dragged = widthPx(root, 1);

        // The header is rebuilt when the drag ends, so re-query it.
        root.querySelectorAll<HTMLElement>('.ch-resizer')[1].dispatchEvent(
            new MouseEvent('dblclick', { bubbles: true, cancelable: true })
        );
        expect(widthPx(root, 1)).toBeLessThan(dragged);
    });

    it('fits to every loaded row, not just the sample the first measure took', () => {
        const { root, send } = mount();
        start(send);
        // The initial measurement samples 200 rows; the wide value is past that.
        const rows: unknown[][] = Array.from({ length: 300 }, (_, i) => [String(i), 'short']);
        rows[250] = ['250', 'a-value-far-wider-than-any-of-the-others'];
        send({ type: 'rows', rows, total: rows.length });

        const sampled = widthPx(root, 1);
        root.querySelectorAll<HTMLElement>('.ch-resizer')[1].dispatchEvent(
            new MouseEvent('dblclick', { bubbles: true, cancelable: true })
        );
        expect(widthPx(root, 1)).toBeGreaterThan(sampled);
    });
});
