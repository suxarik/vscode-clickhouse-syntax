/**
 * @jest-environment jsdom
 *
 * Tests for the plan view.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { PlanView, formatDuration } from '../explain/view/planView';
import { buildPlanGraph, ProcessorRow } from '../explain/graph';
import { PlanHostMessage, PlanPayload, PlanTransport, PlanViewMessage } from '../explain/protocol';

function payload(over: Partial<PlanPayload> = {}): PlanPayload {
    const rows = readFileSync(join(__dirname, 'fixtures', 'processors-profile.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as ProcessorRow);

    return {
        sql: 'SELECT user_id FROM events',
        profile: 'local',
        explain: readFileSync(join(__dirname, 'fixtures', 'explain-plan.txt'), 'utf8'),
        graph: buildPlanGraph(rows),
        summary: {
            query_duration_ms: 31,
            read_rows: 1566400,
            read_bytes: 27467652,
            memory_usage: 13983538,
            threads: 18,
        },
        timedOut: false,
        ...over,
    };
}

function mount() {
    const root = document.createElement('div');
    document.body.append(root);
    Object.defineProperty(root, 'clientWidth', { value: 900, configurable: true });

    const sent: PlanViewMessage[] = [];
    let handler: ((message: PlanHostMessage) => void) | undefined;
    const transport: PlanTransport = {
        post: message => sent.push(message),
        onMessage: fn => (handler = fn),
    };

    const view = new PlanView(root, transport);
    return { root, view, sent, send: (message: PlanHostMessage) => handler?.(message) };
}

afterEach(() => {
    document.body.innerHTML = '';
});

describe('formatDuration', () => {
    it('reads in the unit the number deserves', () => {
        expect(formatDuration(412)).toBe('412µs');
        expect(formatDuration(57_078)).toBe('57ms');
        expect(formatDuration(2_400_000)).toBe('2.40s');
    });
});

describe('PlanView', () => {
    it('tells the host it is listening before anything is sent to it', () => {
        const { sent } = mount();
        expect(sent).toContainEqual({ type: 'ready' });
    });

    it('draws a bar for every step', () => {
        const { root, send } = mount();
        send({ type: 'plan', payload: payload() });

        const bars = root.querySelectorAll('.ch-canvas .ch-cell');
        expect(bars.length).toBeGreaterThan(3);
    });

    it('shows the plan text the server returned, beside the drawing', () => {
        const { root, send } = mount();
        send({ type: 'plan', payload: payload() });

        expect(root.querySelector('.ch-explain-body')?.textContent).toContain('ReadFromMergeTree');
    });

    it('separates wall clock from CPU, which are not the same number', () => {
        const { root, send } = mount();
        send({ type: 'plan', payload: payload() });

        const summary = root.querySelector('.ch-summary')?.textContent ?? '';
        expect(summary).toContain('wall clock');
        expect(summary).toContain('31 ms');
        expect(summary).toContain('CPU');
        // 82ms of CPU in 31ms of wall clock is the parallelism worth reporting.
        expect(summary).toContain('parallelism');
    });

    it('switches to the node-link view on request', () => {
        const { root, send } = mount();
        send({ type: 'plan', payload: payload() });

        const graphButton = [...root.querySelectorAll('.ch-views button')].find(
            button => button.textContent === 'Graph'
        ) as HTMLButtonElement;
        graphButton.click();

        expect(root.querySelectorAll('.ch-canvas path').length).toBeGreaterThan(0);
        expect(graphButton.className).toContain('ch-on');
    });

    it('labels each edge with the rows crossing it', () => {
        const { root, send } = mount();
        send({ type: 'plan', payload: payload() });
        ([...root.querySelectorAll('.ch-views button')].find(b => b.textContent === 'Graph') as HTMLButtonElement).click();

        const labels = [...root.querySelectorAll('.ch-canvas text')].map(t => t.textContent ?? '');
        expect(labels.some(text => /\d/.test(text))).toBe(true);
        expect(root.querySelectorAll('.ch-canvas path.ch-edge').length).toBeGreaterThan(0);
    });

    it('points each edge at the step it feeds', () => {
        const { root, send } = mount();
        send({ type: 'plan', payload: payload() });
        ([...root.querySelectorAll('.ch-views button')].find(b => b.textContent === 'Graph') as HTMLButtonElement).click();

        // Rows flow from the producer up into its consumer, and the drawing
        // should say which end is which without the reader inferring it.
        const marker = root.querySelector('.ch-canvas marker')!;
        // Edge weight carries row volume, from 1px to 6px. An arrowhead scaled
        // by stroke width would therefore range over six times its own size.
        expect(marker.getAttribute('markerUnits')).toBe('userSpaceOnUse');
        const edges = [...root.querySelectorAll('.ch-canvas path.ch-edge')];
        expect(edges.length).toBeGreaterThan(0);
        expect(edges.every(edge => edge.getAttribute('marker-end'))).toBe(true);
    });

    it('numbers the steps so the graph has a reading order', () => {
        const { root, send } = mount();
        send({ type: 'plan', payload: payload() });
        ([...root.querySelectorAll('.ch-views button')].find(b => b.textContent === 'Graph') as HTMLButtonElement).click();

        const numbers = [...root.querySelectorAll('.ch-cell text')]
            .map(t => Number(t.textContent))
            .filter(value => Number.isInteger(value) && value > 0);
        expect(numbers).toContain(1);
    });

    it('marks the matching plan line when a step is selected', () => {
        const { root, send } = mount();
        send({ type: 'plan', payload: payload() });

        const cells = [...root.querySelectorAll('.ch-cell')] as SVGGElement[];
        const read = cells.find(cell => (cell.textContent ?? '').includes('ReadFromMergeTree'))!;
        read.dispatchEvent(new MouseEvent('click', { bubbles: true }));

        expect(root.querySelectorAll('.ch-explain-body .ch-match').length).toBeGreaterThan(0);
    });

    it('scales the drawing down to fit, and never magnifies it', () => {
        const { root, send } = mount();
        Object.defineProperty(root.querySelector('.ch-canvas')!, 'clientWidth', { value: 400, configurable: true });
        Object.defineProperty(root.querySelector('.ch-canvas')!, 'clientHeight', { value: 300, configurable: true });
        send({ type: 'plan', payload: payload() });

        const svg = root.querySelector('.ch-canvas svg')!;
        expect(Number(svg.getAttribute('width'))).toBeLessThanOrEqual(400);
    });

    it('draws at natural size at 1:1, whatever the panel is', () => {
        const { root, send } = mount();
        const canvas = root.querySelector('.ch-canvas')!;
        Object.defineProperty(canvas, 'clientWidth', { value: 400, configurable: true });
        Object.defineProperty(canvas, 'clientHeight', { value: 300, configurable: true });
        send({ type: 'plan', payload: payload() });

        const oneToOne = [...root.querySelectorAll('.ch-zooms button')].find(
            button => button.textContent === '1:1'
        ) as HTMLButtonElement;
        oneToOne.click();

        const svg = root.querySelector('.ch-canvas svg')!;
        expect(Number(svg.getAttribute('width'))).toBeGreaterThan(400);
        expect(oneToOne.className).toContain('ch-on');
    });

    it('does not call waiting parallelism', () => {
        const { root, send } = mount();
        // 38ms of CPU inside 192ms of wall clock is a query that waited.
        send({
            type: 'plan',
            payload: payload({
                summary: { query_duration_ms: 192, read_rows: 1, read_bytes: 1, memory_usage: 1, threads: 8 },
            }),
        });

        const summary = root.querySelector('.ch-summary')?.textContent ?? '';
        expect(summary).not.toContain('parallelism');
        expect(summary).toContain('waiting');
    });

    it('hatches only a step that did real work yet mostly waited', () => {
        // Nearly every step in a pipeline waits on something. Hatching each one
        // marks the whole drawing, which marks nothing.
        const { root, send } = mount();
        send({ type: 'plan', payload: payload() });

        const bars = root.querySelectorAll('.ch-canvas .ch-cell').length;
        const hatched = root.querySelectorAll('[fill="url(#ch-wait)"]').length;
        expect(hatched).toBeLessThan(bars / 2);
    });

    it('hands the host SVG source to save', async () => {
        const { root, send, sent } = mount();
        send({ type: 'plan', payload: payload() });

        const svgButton = [...root.querySelectorAll('.ch-export button')].find(
            button => button.textContent === 'SVG'
        ) as HTMLButtonElement;
        svgButton.click();
        await Promise.resolve();

        const exported = sent.find(message => message.type === 'export');
        expect(exported).toMatchObject({ type: 'export', format: 'svg' });
        expect(exported && 'data' in exported && exported.data).toContain('<svg');
    });

    it('says what to do when the profile never arrived', () => {
        const { root, send } = mount();
        send({ type: 'error', message: 'The query ran, but the log had not been written yet.' });

        expect(root.querySelector('.ch-empty')?.textContent).toContain('had not been written');
    });
});
