/**
 * Plan layout geometry.
 *
 * Everything here is a fraction of the available space, never a pixel, so one
 * layout serves the panel at any width, a zoomed subtree, and an exported image
 * at any size. Pixels belong to the renderer.
 *
 * The flame is an icicle: the sink at the top holding the whole width, and each
 * node below it holding the share of that width its own subtree cost. What a
 * node did itself is the width its children do not cover, so self-heavy work
 * shows up as a ledge rather than having to be read off a label.
 */
import { PlanGraph, PlanGraphNode } from '../graph';

export interface FlameCell {
    id: string;
    label: string;
    depth: number;
    /** Left edge, as a fraction of the whole width. */
    x: number;
    /** Width as a fraction of the whole, i.e. the subtree's share of CPU. */
    width: number;
    /** The node's own CPU as a fraction of the whole. */
    selfShare: number;
    hot: boolean;
    /** Zero unless this row stands for a folded run of steps. */
    foldedCount: number;
    node: FoldedNode;
}

/** CPU of a node plus everything feeding it. */
function subtreeCost(
    byId: Map<string, FoldedNode>,
    id: string,
    memo: Map<string, number>,
    path: Set<string>
): number {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    if (path.has(id)) return 0;

    path.add(id);
    const node = byId.get(id);
    let total = node?.cpuUs ?? 0;
    for (const input of node?.inputs ?? []) total += subtreeCost(byId, input, memo, path);
    path.delete(id);

    memo.set(id, total);
    return total;
}

export function flameLayout(graph: PlanGraph, options: FoldOptions = {}): FlameCell[] {
    const folded = foldGraph(graph, options);
    const byId = new Map(folded.nodes.map(node => [node.id, node]));
    const memo = new Map<string, number>();
    const hot = new Set(folded.hotPath);
    const cost = (id: string): number => subtreeCost(byId, id, memo, new Set());

    const cells: FlameCell[] = [];
    const total = folded.rootIds.reduce((sum, id) => sum + cost(id), 0) || 1;

    const place = (
        ids: string[],
        left: number,
        available: number,
        parentCost: number,
        depth: number,
        seen: Set<string>
    ): void => {
        // Heaviest first: the thing worth looking at should be where the eye
        // already is, rather than wherever the server happened to list it.
        const ordered = [...ids].sort((a, b) => cost(b) - cost(a));
        const span = parentCost || 1;

        let x = left;
        for (const id of ordered) {
            if (seen.has(id)) continue;
            const node = byId.get(id);
            if (!node) continue;

            // Measured against the parent, not against the other children, so
            // the width a parent keeps for itself is the work it did itself.
            const width = available * (cost(id) / span);
            cells.push({
                id,
                label: node.label,
                depth,
                x,
                width,
                selfShare: total > 0 ? node.cpuUs / total : 0,
                hot: hot.has(id),
                foldedCount: node.foldedCount,
                node,
            });

            const nested = new Set(seen);
            nested.add(id);
            place(node.inputs, x, width, cost(id), depth + 1, nested);
            x += width;
        }
    };

    place(folded.rootIds, 0, 1, total, 0, new Set());
    return cells;
}


// ── Folding ──────────────────────────────────────────────────────────────────

/** A node after folding: either one step, or a run of steps too small to draw. */
export interface FoldedNode extends PlanGraphNode {
    /** True when this stands for a run of steps rather than one step. */
    folded: boolean;
    /** Zero when this is a real step. */
    foldedCount: number;
    members: PlanGraphNode[];
}

export interface FoldedGraph extends Omit<PlanGraph, 'nodes'> {
    nodes: FoldedNode[];
}

export interface FoldOptions {
    /** Steps below this share of CPU may be folded. Zero keeps every step. */
    foldBelow?: number;
}

const DEFAULT_FOLD_BELOW = 0.01;

/**
 * Collapse runs of negligible steps.
 *
 * A pipeline carries bookkeeping that cost nothing — four separate `Expression`
 * steps at a tenth of a percent each is ordinary. Drawn at the same size as the
 * table read, they turn the picture into a wall of equal boxes, which is the
 * failure this view exists to avoid.
 *
 * Only a plain chain folds. Folding a fork would change the shape of the query,
 * and the shape is the thing being shown.
 */
export function foldGraph(graph: PlanGraph, options: FoldOptions = {}): FoldedGraph {
    const foldBelow = options.foldBelow ?? DEFAULT_FOLD_BELOW;
    const byId = new Map(graph.nodes.map(node => [node.id, node]));

    const consumers = new Map<string, string[]>();
    for (const node of graph.nodes) {
        for (const input of node.inputs) {
            consumers.set(input, [...(consumers.get(input) ?? []), node.id]);
        }
    }

    const foldable = (id: string): boolean => {
        const node = byId.get(id);
        if (!node || node.share >= foldBelow) return false;
        return node.inputs.length === 1 && (consumers.get(id) ?? []).length === 1;
    };

    // Start only at the top of a chain, so a run is always the whole run and
    // never depends on which end the walk reached first.
    const runOf = new Map<string, string>();
    const runs = new Map<string, PlanGraphNode[]>();
    for (const node of graph.nodes) {
        if (!foldable(node.id)) continue;
        const above = (consumers.get(node.id) ?? [])[0];
        if (above && foldable(above)) continue;

        const members: PlanGraphNode[] = [];
        for (let id: string | undefined = node.id; id && foldable(id) && !runOf.has(id); ) {
            members.push(byId.get(id)!);
            id = byId.get(id)!.inputs[0];
        }
        if (members.length < 2) continue;

        const runId = `fold:${members[members.length - 1].id}`;
        for (const member of members) runOf.set(member.id, runId);
        runs.set(runId, members);
    }

    const represent = (id: string): string => runOf.get(id) ?? id;

    const nodes: FoldedNode[] = [];
    for (const node of graph.nodes) {
        if (runOf.has(node.id)) continue;
        nodes.push({ ...node, folded: false, foldedCount: 0, members: [node] });
    }
    for (const [runId, members] of runs) {
        nodes.push(combine(runId, members));
    }

    const present = new Set(nodes.map(node => node.id));
    for (const node of nodes) {
        const inputs = new Set<string>();
        for (const member of node.members) {
            for (const input of member.inputs) {
                const from = represent(input);
                if (from !== node.id && present.has(from)) inputs.add(from);
            }
        }
        node.inputs = [...inputs];
    }

    const rootIds = [...new Set(graph.rootIds.map(represent))].filter(id => present.has(id));
    const hotPath = [...new Set(graph.hotPath.map(represent))].filter(id => present.has(id));
    return { nodes, rootIds, totalCpuUs: graph.totalCpuUs, hotPath };
}

function combine(runId: string, members: PlanGraphNode[]): FoldedNode {
    const sum = (pick: (node: PlanGraphNode) => number): number =>
        members.reduce((total, member) => total + pick(member), 0);

    return {
        id: runId,
        label: `${members.length} minor steps`,
        description: members.map(member => member.label).join(' → '),
        attached: members.every(member => member.attached),
        processors: sum(member => member.processors),
        cpuUs: sum(member => member.cpuUs),
        inputWaitUs: sum(member => member.inputWaitUs),
        outputWaitUs: sum(member => member.outputWaitUs),
        inputRows: members[members.length - 1]?.inputRows ?? 0,
        outputRows: members[0]?.outputRows ?? 0,
        inputBytes: members[members.length - 1]?.inputBytes ?? 0,
        outputBytes: members[0]?.outputBytes ?? 0,
        inputs: [],
        share: sum(member => member.share),
        folded: true,
        foldedCount: members.length,
        members,
    };
}

// ── Node-link layout ─────────────────────────────────────────────────────────

export interface DagNode extends FoldedNode {
    depth: number;
    /** All fractions of the drawing area. */
    x: number;
    y: number;
    width: number;
    height: number;
    hot: boolean;
}

export interface DagEdge {
    /** The node producing rows. Always deeper than `to`. */
    from: string;
    to: string;
    rows: number;
}

export interface DagLayoutResult {
    nodes: DagNode[];
    edges: DagEdge[];
}

/** Shortest box that still fits a label, and the tallest we will draw. */
const MIN_UNITS = 1;
const MAX_UNITS = 3.2;
const LAYER_GAP = 0.9;

export function dagLayout(graph: PlanGraph, options: FoldOptions = {}): DagLayoutResult {
    const folded = foldGraph(graph, options);
    const hot = new Set(folded.hotPath);

    const nodes: DagNode[] = folded.nodes.map(node => ({
        ...node,
        depth: 0,
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        hot: hot.has(node.id),
    }));

    assignDepths(nodes);
    position(nodes);

    const byId = new Map(nodes.map(node => [node.id, node]));
    const edges: DagEdge[] = [];
    for (const node of nodes) {
        for (const from of node.inputs) {
            edges.push({ from, to: node.id, rows: byId.get(from)?.outputRows ?? 0 });
        }
    }

    return { nodes: nodes.sort((a, b) => a.depth - b.depth || a.x - b.x), edges };
}

/** A node sits one level below the deepest thing it feeds, so edges only descend. */
function assignDepths(nodes: DagNode[]): void {
    const consumersOf = new Map<string, string[]>(nodes.map(node => [node.id, []]));
    for (const node of nodes) {
        for (const from of node.inputs) consumersOf.get(from)?.push(node.id);
    }

    const depths = new Map<string, number>();
    const depthOf = (id: string, path: Set<string>): number => {
        const cached = depths.get(id);
        if (cached !== undefined) return cached;
        if (path.has(id)) return 0;

        path.add(id);
        const above = consumersOf.get(id) ?? [];
        const depth = above.length === 0 ? 0 : Math.max(...above.map(parent => depthOf(parent, path))) + 1;
        path.delete(id);

        depths.set(id, depth);
        return depth;
    };

    for (const node of nodes) node.depth = depthOf(node.id, new Set());
}

/** Stack the layers, sizing each box by the CPU it stands for. */
function position(nodes: DagNode[]): void {
    const units = (share: number): number => MIN_UNITS + (MAX_UNITS - MIN_UNITS) * Math.sqrt(Math.max(0, share));

    const layers = new Map<number, DagNode[]>();
    for (const node of nodes) layers.set(node.depth, [...(layers.get(node.depth) ?? []), node]);

    const depths = [...layers.keys()].sort((a, b) => a - b);
    const layerHeight = new Map<number, number>(
        depths.map(depth => [depth, Math.max(...layers.get(depth)!.map(node => units(node.share)))])
    );
    const totalUnits =
        depths.reduce((sum, depth) => sum + layerHeight.get(depth)!, 0) + LAYER_GAP * Math.max(0, depths.length - 1);

    let cursor = 0;
    for (const depth of depths) {
        const row = layers.get(depth)!.sort((a, b) => b.share - a.share);
        const slot = 1 / row.length;
        row.forEach((node, index) => {
            node.width = slot * 0.84;
            node.x = index * slot + slot * 0.08;
            node.y = cursor / totalUnits;
            node.height = units(node.share) / totalUnits;
        });
        cursor += layerHeight.get(depth)! + LAYER_GAP;
    }
}
