/**
 * Laying a cluster out.
 *
 * A plan is a measurement, so its geometry carries the numbers. A cluster is a
 * map, and the shape is the information: shards across, replicas down. Sizing a
 * replica by the rows it holds would make the busiest shard look like more of
 * the cluster than it is, so every box is the same and the data is drawn
 * inside it.
 */
import { ClusterView } from '../types';

export type NodeState = 'ok' | 'unreachable' | 'readonly' | 'lagging';

export interface ClusterCell {
    shard: number;
    replica: number;
    host: string;
    isLocal: boolean;
    /** Fractions of the drawing. */
    x: number;
    y: number;
    width: number;
    height: number;
    rows: number;
    bytes: number;
    parts: number;
    /** Rows held as a fraction of the busiest node's, for the bar inside. */
    share: number;
    state: NodeState;
}

export interface ShardColumn {
    shard: number;
    x: number;
    width: number;
    replicas: number;
    rows: number;
}

export interface ClusterLayoutResult {
    cells: ClusterCell[];
    shards: ShardColumn[];
}

export interface ClusterLayoutOptions {
    /** `database.table` to show, or every table added together. */
    table?: string;
}

/** Lag past which a replica is worth drawing differently. */
const LAG_SECONDS = 30;
const GUTTER = 0.04;

export function clusterLayout(view: ClusterView, options: ClusterLayoutOptions = {}): ClusterLayoutResult {
    const shardNumbers = [...new Set(view.hosts.map(host => host.shard))].sort((a, b) => a - b);
    const deepest = Math.max(1, ...shardNumbers.map(shard => view.hosts.filter(h => h.shard === shard).length));

    const unreachable = new Set(view.unreachable.map(host => host.host));
    const readonly = new Set(view.health.filter(entry => entry.isReadonly || entry.sessionExpired).map(e => e.host));
    const lagging = new Set(
        view.health.filter(entry => entry.absoluteDelaySeconds >= LAG_SECONDS).map(entry => entry.host)
    );

    const held = new Map<string, { rows: number; bytes: number; parts: number }>();
    for (const entry of view.placement) {
        if (options.table && `${entry.database}.${entry.table}` !== options.table) continue;
        const current = held.get(entry.host) ?? { rows: 0, bytes: 0, parts: 0 };
        held.set(entry.host, {
            rows: current.rows + entry.rows,
            bytes: current.bytes + entry.bytes,
            parts: current.parts + entry.parts,
        });
    }
    const busiest = Math.max(1, ...[...held.values()].map(entry => entry.rows));

    const columnWidth = 1 / shardNumbers.length;
    const rowHeight = 1 / deepest;
    const cells: ClusterCell[] = [];
    const shards: ShardColumn[] = [];

    shardNumbers.forEach((shard, column) => {
        const replicas = view.hosts.filter(host => host.shard === shard).sort((a, b) => a.replica - b.replica);
        const x = column * columnWidth + (columnWidth * GUTTER) / 2;
        const width = columnWidth * (1 - GUTTER);

        let shardRows = 0;
        replicas.forEach((host, row) => {
            const data = held.get(host.host) ?? { rows: 0, bytes: 0, parts: 0 };
            shardRows = Math.max(shardRows, data.rows);

            cells.push({
                shard,
                replica: host.replica,
                host: host.host,
                isLocal: host.isLocal,
                x,
                width,
                y: row * rowHeight + (rowHeight * GUTTER) / 2,
                height: rowHeight * (1 - GUTTER),
                rows: data.rows,
                bytes: data.bytes,
                parts: data.parts,
                share: data.rows / busiest,
                state: unreachable.has(host.host)
                    ? 'unreachable'
                    : readonly.has(host.host)
                      ? 'readonly'
                      : lagging.has(host.host)
                        ? 'lagging'
                        : 'ok',
            });
        });

        shards.push({ shard, x, width, replicas: replicas.length, rows: shardRows });
    });

    return { cells, shards };
}
