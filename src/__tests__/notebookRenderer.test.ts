/**
 * @jest-environment jsdom
 *
 * Tests for the notebook output renderer.
 *
 * The claim this checks is the plan's exit criterion for 2.1: the grid built
 * for the webview runs unmodified in the notebook host. So these drive the real
 * `GridView` through the real renderer, and assert on the DOM it produces.
 */
import { activate } from '../notebook/renderer';
import { CellResult } from '../notebook/controller';

function result(overrides: Partial<CellResult> = {}): CellResult {
    return {
        header: { query: 'SELECT n, name FROM t', profile: 'local', queryId: 'q1' },
        columns: [
            { name: 'n', type: 'UInt64' },
            { name: 'name', type: 'String' },
        ],
        rows: [
            ['1', 'alpha'],
            ['2', 'beta'],
        ],
        statistics: { elapsedMs: 12, resultRows: 2 },
        truncated: false,
        ...overrides,
    };
}

/** Render one output into a fresh element, as VS Code would. */
function render(value: CellResult, context: Parameters<typeof activate>[0] = {}) {
    const renderer = activate(context);
    const element = document.createElement('div');
    document.body.appendChild(element);
    renderer.renderOutputItem({ id: 'out-1', json: () => value }, element);
    return { element, renderer };
}

beforeEach(() => {
    document.head.replaceChildren();
    document.body.replaceChildren();
});

describe('rendering an output', () => {
    it('draws the same grid the webview does', () => {
        const { element } = render(result());
        expect(element.querySelector('.ch-results')).not.toBeNull();
        expect(element.querySelectorAll('.ch-head .ch-header-cell')).toHaveLength(2);
        expect(element.textContent).toContain('alpha');
        expect(element.textContent).toContain('beta');
    });

    it('names the profile the rows came from', () => {
        // Which server answered is not something a notebook output may leave out.
        const { element } = render(result());
        expect(element.textContent).toContain('local');
    });

    it('injects the grid styles once, however many outputs there are', () => {
        render(result());
        render(result());
        render(result());
        expect(document.querySelectorAll('#ch-grid-style')).toHaveLength(1);
        expect(document.getElementById('ch-grid-style')!.textContent).toContain('.ch-results');
    });

    it('hides the cancel button, because a stored result has nothing to cancel', () => {
        render(result());
        expect(document.getElementById('ch-grid-style')!.textContent).toContain('.ch-cancel { display: none; }');
    });

    it('shows an error instead of an empty grid', () => {
        const { element } = render(result({ rows: [], columns: [], error: 'Unknown identifier: bad' }));
        expect(element.textContent).toContain('Unknown identifier: bad');
    });

    it('says when the result was cut short', () => {
        const { element } = render(result({ truncated: true }));
        expect(element.textContent?.toLowerCase()).toContain('truncated');
    });

    it('replaces what was there rather than appending on a re-render', () => {
        const renderer = activate({});
        const element = document.createElement('div');
        document.body.appendChild(element);
        renderer.renderOutputItem({ id: 'out-1', json: () => result() }, element);
        renderer.renderOutputItem({ id: 'out-1', json: () => result() }, element);
        expect(element.querySelectorAll('.ch-results')).toHaveLength(1);
    });

    it('handles an empty result without throwing', () => {
        const { element } = render(result({ rows: [], columns: [] }));
        expect(element.querySelector('.ch-results')).not.toBeNull();
    });
});

describe('what crosses back to the extension host', () => {
    /** Click a toolbar button, the way the buttons are actually marked up. */
    function clickAction(element: HTMLElement, action: string, format: string) {
        const button = element.querySelector<HTMLElement>(
            `[data-action="${action}"][data-format="${format}"]`
        );
        if (!button) throw new Error(`no toolbar action ${action}/${format}`);
        button.click();
    }

    it('sends the finished text, not a request to go and find the rows', () => {
        const postMessage = jest.fn();
        const { element } = render(result(), { postMessage });

        clickAction(element, 'copy', 'tsv');

        expect(postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'copy', format: 'tsv', text: expect.stringContaining('alpha') })
        );
        // The rows are already here; the host only needs the text.
        expect(postMessage.mock.calls[0][0].text).toContain('n\tname');
    });

    it('suggests a filename that says which query it came from', () => {
        const postMessage = jest.fn();
        const { element } = render(result(), { postMessage });

        clickAction(element, 'export', 'csv');

        expect(postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'export', format: 'csv', suggestedName: 'select-n-name-from-t' })
        );
    });

    it('falls back to a plain name when the query has nothing nameable in it', () => {
        const postMessage = jest.fn();
        const { element } = render(result({ header: { query: '!!!', profile: 'p', queryId: 'q' } }), {
            postMessage,
        });

        clickAction(element, 'export', 'json');

        expect(postMessage.mock.calls[0][0].suggestedName).toBe('clickhouse-result');
    });

    it('sends nothing at all when there is no messaging channel', () => {
        // `requiresMessaging: optional` means the renderer must still work.
        const { element } = render(result());
        expect(() => clickAction(element, 'copy', 'csv')).not.toThrow();
    });

    it('swallows a cancel, which would otherwise reach a query that has finished', () => {
        const postMessage = jest.fn();
        const { element } = render(result(), { postMessage });
        element.querySelector<HTMLElement>('.ch-cancel')?.click();
        expect(postMessage).not.toHaveBeenCalled();
    });
});
