/**
 * @jest-environment jsdom
 *
 * Tests for the cluster map.
 */
import { ClusterView as ClusterViewClass } from '../cluster/view/clusterView';
import { ClusterHostMessage, ClusterPayload, ClusterTransport, ClusterViewMessage } from '../cluster/protocol';
import { ClusterHost, ClusterView, DataPlacement } from '../cluster/types';

const host = (shard: number, replica: number, name: string): ClusterHost => ({
    cluster: 'analytics',
    shard,
    replica,
    host: name,
    port: 9000,
    isLocal: shard === 1 && replica === 1,
    errors: 0,
    slowdowns: 0,
    estimatedRecoverySeconds: 0,
});

const placed = (shard: string, name: string, rows: number, table = 'events_local'): DataPlacement => ({
    shard,
    host: name,
    database: 'demo',
    table,
    rows,
    bytes: rows * 20,
    parts: 3,
});

function payload(over: Partial<ClusterView> = {}): ClusterPayload {
    const view: ClusterView = {
        cluster: 'analytics',
        hosts: [host(1, 1, 'ch-01'), host(1, 2, 'ch-02'), host(2, 1, 'ch-03'), host(2, 2, 'ch-04')],
        health: [],
        unreachable: [],
        placement: [
            placed('1', 'ch-01', 800_000),
            placed('1', 'ch-02', 800_000),
            placed('2', 'ch-03', 400_000),
            placed('2', 'ch-04', 400_000),
        ],
        ...over,
    };
    return { view, tables: ['demo.events_local'], fetchedAt: Date.now() };
}

function mount() {
    const root = document.createElement('div');
    document.body.append(root);
    const sent: ClusterViewMessage[] = [];
    let handler: ((message: ClusterHostMessage) => void) | undefined;
    const transport: ClusterTransport = {
        post: message => sent.push(message),
        onMessage: fn => (handler = fn),
    };
    new ClusterViewClass(root, transport);
    return { root, sent, send: (message: ClusterHostMessage) => handler?.(message) };
}

afterEach(() => {
    document.body.innerHTML = '';
});

describe('ClusterView', () => {
    it('draws a box for every configured replica', () => {
        const { root, send } = mount();
        send({ type: 'cluster', payload: payload() });
        expect(root.querySelectorAll('.ch-node')).toHaveLength(4);
    });

    it('labels each shard with how many replicas it has', () => {
        const { root, send } = mount();
        send({ type: 'cluster', payload: payload() });
        const labels = [...root.querySelectorAll('.ch-shard-label')].map(l => l.textContent ?? '');
        expect(labels.some(text => text.includes('shard 1') && text.includes('2 replicas'))).toBe(true);
    });

    it('says which node the connection is to', () => {
        const { root, send } = mount();
        send({ type: 'cluster', payload: payload() });
        expect(root.querySelector('.ch-canvas')?.textContent ?? '').toContain('(connected)');
    });

    it('draws a host that did not answer differently', () => {
        const { root, send } = mount();
        send({ type: 'cluster', payload: payload({ unreachable: [host(2, 2, 'ch-04')] }) });

        const dashed = [...root.querySelectorAll('.ch-node rect')].filter(
            rect => rect.getAttribute('stroke-dasharray')
        );
        expect(dashed.length).toBe(1);
        expect(root.querySelector('.ch-canvas')?.textContent ?? '').toContain('did not answer');
    });

    it('counts the cluster in the summary', () => {
        const { root, send } = mount();
        send({ type: 'cluster', payload: payload({ unreachable: [host(2, 2, 'ch-04')] }) });

        const summary = root.querySelector('.ch-summary')?.textContent ?? '';
        expect(summary).toContain('shards');
        expect(summary).toContain('answering');
        expect(summary).toContain('3');
    });

    it('says what the picture means', () => {
        const { root, send } = mount();
        send({ type: 'cluster', payload: payload() });
        expect(root.querySelector('.ch-legend')?.textContent ?? '').toContain('same size');
    });

    it('offers the tables it found, and all of them together', () => {
        const { root, send } = mount();
        send({ type: 'cluster', payload: payload() });

        const options = [...root.querySelectorAll('.ch-picker option')].map(o => o.textContent);
        expect(options).toContain('all tables');
        expect(options).toContain('demo.events_local');
    });

    it('asks the host to read the cluster again', () => {
        const { root, sent, send } = mount();
        send({ type: 'cluster', payload: payload() });
        (root.querySelector('.ch-refresh') as HTMLButtonElement).click();
        expect(sent).toContainEqual({ type: 'refresh' });
    });

    it('shows the cluster findings beside the map', () => {
        const { root, send } = mount();
        send({ type: 'cluster', payload: payload() });
        send({
            type: 'findings',
            findings: [
                {
                    ruleId: 'shard-skew',
                    importance: 'medium',
                    title: 'demo.events_local is spread unevenly',
                    evidence: 'shard 1 holds 66.7%',
                },
            ],
        });
        expect(root.querySelector('.ch-findings')?.textContent ?? '').toContain('66.7%');
    });

    it('hands the host an image to save', async () => {
        const { root, sent, send } = mount();
        send({ type: 'cluster', payload: payload() });
        ([...root.querySelectorAll('.ch-export button')].find(b => b.textContent === 'SVG') as HTMLButtonElement).click();
        await Promise.resolve();

        const exported = sent.find(message => message.type === 'export');
        expect(exported).toMatchObject({ type: 'export', format: 'svg' });
    });
});
