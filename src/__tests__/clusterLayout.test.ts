/**
 * Tests for laying a cluster out.
 *
 * Unlike a plan, a cluster is a map: the shape is the information, so the boxes
 * keep their size and the data is drawn inside them. Sizing a replica by the
 * rows it holds would make the busiest shard look like more of a cluster than
 * it is.
 */
import { clusterLayout } from '../cluster/view/layout';
import { ClusterHost, ClusterView, DataPlacement, ReplicaHealth } from '../cluster/types';

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

const placed = (shard: string, name: string, rows: number): DataPlacement => ({
    shard,
    host: name,
    database: 'demo',
    table: 'events_local',
    rows,
    bytes: rows * 20,
    parts: 3,
});

const view = (over: Partial<ClusterView> = {}): ClusterView => ({
    cluster: 'analytics',
    hosts: [host(1, 1, 'ch-01'), host(1, 2, 'ch-02'), host(2, 1, 'ch-03'), host(2, 2, 'ch-04')],
    health: [],
    unreachable: [],
    placement: [],
    ...over,
});

describe('clusterLayout', () => {
    it('gives each shard a column and each replica a row in it', () => {
        const laid = clusterLayout(view());

        expect(laid.shards.map(shard => shard.shard)).toEqual([1, 2]);
        expect(laid.cells).toHaveLength(4);

        const first = laid.cells.filter(cell => cell.shard === 1);
        const second = laid.cells.filter(cell => cell.shard === 2);
        expect(first.every(cell => cell.x < second[0].x)).toBe(true);
        expect(first[0].y).toBeLessThan(first[1].y);
    });

    it('keeps every replica the same size, because a map is not a measurement', () => {
        const laid = clusterLayout(
            view({ placement: [placed('1', 'ch-01', 1_000_000), placed('2', 'ch-03', 10)] })
        );
        const sizes = new Set(laid.cells.map(cell => `${cell.width.toFixed(4)}x${cell.height.toFixed(4)}`));
        expect(sizes.size).toBe(1);
    });

    it('carries the rows each node holds, as a share of the busiest', () => {
        const laid = clusterLayout(
            view({ placement: [placed('1', 'ch-01', 800_000), placed('2', 'ch-03', 400_000)] })
        );

        expect(laid.cells.find(cell => cell.host === 'ch-01')?.share).toBeCloseTo(1);
        expect(laid.cells.find(cell => cell.host === 'ch-03')?.share).toBeCloseTo(0.5);
        expect(laid.cells.find(cell => cell.host === 'ch-01')?.rows).toBe(800_000);
    });

    it('marks a host that did not answer', () => {
        const laid = clusterLayout(view({ unreachable: [host(2, 2, 'ch-04')] }));
        expect(laid.cells.find(cell => cell.host === 'ch-04')?.state).toBe('unreachable');
        expect(laid.cells.find(cell => cell.host === 'ch-01')?.state).toBe('ok');
    });

    it('marks a read-only replica, which is a different kind of broken', () => {
        const health: ReplicaHealth = {
            host: 'ch-02',
            database: 'demo',
            table: 'events_local',
            isReadonly: true,
            readonlySeconds: 60,
            sessionExpired: false,
            absoluteDelaySeconds: 0,
            queueSize: 0,
            totalReplicas: 2,
            activeReplicas: 2,
            lostParts: 0,
        };
        const laid = clusterLayout(view({ health: [health] }));
        expect(laid.cells.find(cell => cell.host === 'ch-02')?.state).toBe('readonly');
    });

    it('marks a replica that has fallen behind', () => {
        const health: ReplicaHealth = {
            host: 'ch-03',
            database: 'demo',
            table: 'events_local',
            isReadonly: false,
            readonlySeconds: 0,
            sessionExpired: false,
            absoluteDelaySeconds: 340,
            queueSize: 0,
            totalReplicas: 2,
            activeReplicas: 2,
            lostParts: 0,
        };
        expect(clusterLayout(view({ health: [health] })).cells.find(c => c.host === 'ch-03')?.state).toBe(
            'lagging'
        );
    });

    it('shows one table when asked, and everything otherwise', () => {
        const all = view({
            placement: [
                placed('1', 'ch-01', 100),
                { ...placed('1', 'ch-01', 900), table: 'other_local' },
            ],
        });

        expect(clusterLayout(all).cells.find(cell => cell.host === 'ch-01')?.rows).toBe(1000);
        expect(clusterLayout(all, { table: 'demo.events_local' }).cells.find(c => c.host === 'ch-01')?.rows).toBe(
            100
        );
    });

    it('keeps everything inside the drawing', () => {
        const laid = clusterLayout(view());
        for (const cell of laid.cells) {
            expect(cell.x).toBeGreaterThanOrEqual(0);
            expect(cell.x + cell.width).toBeLessThanOrEqual(1 + 1e-9);
            expect(cell.y + cell.height).toBeLessThanOrEqual(1 + 1e-9);
        }
    });

    it('copes with shards that have different numbers of replicas', () => {
        const laid = clusterLayout(
            view({ hosts: [host(1, 1, 'ch-01'), host(2, 1, 'ch-03'), host(2, 2, 'ch-04')] })
        );
        expect(laid.cells).toHaveLength(3);
        expect(laid.shards).toHaveLength(2);
    });
});
