/**
 * Turning processor profile rows into a plan graph.
 *
 * `system.processors_profile_log` records one row per processor, and ClickHouse
 * runs one processor per thread — 54 rows for a single GROUP BY is ordinary.
 * Drawing those directly would be unreadable, so processors are collapsed into
 * the plan step they belong to, and their edges lifted with them.
 *
 * `elapsed_us` is CPU time. Summing it across processors gives work done, not
 * wall-clock: a query running on eighteen threads reports far more CPU time
 * than it took to run. Wall-clock belongs to `system.query_log`, and the two
 * must never be presented as the same number.
 */

/** One row of `system.processors_profile_log`. */
export interface ProcessorRow {
    /** UInt64, which may arrive as a string to stay exact. */
    id: string | number;
    /** The processors this one feeds. Empty for the sink. */
    parent_ids: Array<string | number>;
    plan_step: string | number;
    plan_step_name: string;
    plan_step_description: string;
    plan_group: number;
    /** Stable per-step key, e.g. `Aggregating_4`. Empty for pipeline processors. */
    step_uniq_id: string;
    name: string;
    elapsed_us: number | string;
    input_wait_elapsed_us: number | string;
    output_wait_elapsed_us: number | string;
    input_rows: number | string;
    input_bytes: number | string;
    output_rows: number | string;
    output_bytes: number | string;
}

export interface PlanGraphNode {
    id: string;
    label: string;
    description: string;
    /** False for processors that belong to the pipeline rather than a plan step. */
    attached: boolean;
    /** How many processors were collapsed into this node, i.e. its parallelism. */
    processors: number;
    /** Summed CPU time across those processors, not wall-clock. */
    cpuUs: number;
    inputWaitUs: number;
    outputWaitUs: number;
    inputRows: number;
    outputRows: number;
    inputBytes: number;
    outputBytes: number;
    /** Nodes feeding this one. */
    inputs: string[];
    /** cpuUs as a fraction of the whole query's CPU time. */
    share: number;
}

export interface PlanGraph {
    nodes: PlanGraphNode[];
    /** Nodes that feed nothing — where the rows come out. */
    rootIds: string[];
    totalCpuUs: number;
    /** Sink first, then down through the heaviest subtree at each step. */
    hotPath: string[];
}

type MutableNode = Omit<PlanGraphNode, 'inputs'> & { inputs: Set<string> };

/**
 * Counters arrive as strings.
 *
 * The client asks ClickHouse to quote 64-bit integers, because `JSON.parse`
 * rounds anything past 2^53 — so every counter here is a string, and adding
 * them without converting first silently concatenates them into a number
 * roughly 10^80 too large.
 */
function num(value: number | string | undefined): number {
    const parsed = typeof value === 'number' ? value : Number(value ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
}

/** A processor with no plan step still needs somewhere to live. */
function nodeIdFor(row: ProcessorRow): string {
    return row.step_uniq_id || `~${row.name}`;
}

function emptyNode(row: ProcessorRow, id: string): MutableNode {
    return {
        id,
        label: (row.step_uniq_id ? row.plan_step_name : '') || row.name,
        description: row.plan_step_description ?? '',
        attached: Boolean(row.step_uniq_id),
        processors: 0,
        cpuUs: 0,
        inputWaitUs: 0,
        outputWaitUs: 0,
        inputRows: 0,
        outputRows: 0,
        inputBytes: 0,
        outputBytes: 0,
        inputs: new Set<string>(),
        share: 0,
    };
}

export function buildPlanGraph(rows: ProcessorRow[]): PlanGraph {
    const nodes = new Map<string, MutableNode>();
    const nodeOfProcessor = new Map<string, string>();

    for (const row of rows) {
        const id = nodeIdFor(row);
        nodeOfProcessor.set(String(row.id), id);

        let node = nodes.get(id);
        if (!node) {
            node = emptyNode(row, id);
            nodes.set(id, node);
        }
        node.processors += 1;
        node.cpuUs += num(row.elapsed_us);
        node.inputWaitUs += num(row.input_wait_elapsed_us);
        node.outputWaitUs += num(row.output_wait_elapsed_us);
        node.inputRows += num(row.input_rows);
        node.outputRows += num(row.output_rows);
        node.inputBytes += num(row.input_bytes);
        node.outputBytes += num(row.output_bytes);
        if (!node.description && row.plan_step_description) node.description = row.plan_step_description;
    }

    // `parent_ids` names what a processor feeds, so the edge is read backwards:
    // the parent gains an input. Lifted to steps, the many parallel copies of
    // one edge collapse into one, and a step feeding itself disappears.
    const feedsSomething = new Set<string>();
    for (const row of rows) {
        const from = nodeOfProcessor.get(String(row.id));
        if (!from) continue;
        for (const parentId of row.parent_ids) {
            const to = nodeOfProcessor.get(String(parentId));
            if (!to || to === from) continue;
            nodes.get(to)?.inputs.add(from);
            feedsSomething.add(from);
        }
    }

    const totalCpuUs = [...nodes.values()].reduce((sum, node) => sum + node.cpuUs, 0);
    for (const node of nodes.values()) {
        node.share = totalCpuUs > 0 ? node.cpuUs / totalCpuUs : 0;
    }

    const finished: PlanGraphNode[] = [...nodes.values()].map(node => ({
        ...node,
        inputs: [...node.inputs],
    }));
    const byId = new Map(finished.map(node => [node.id, node]));
    const rootIds = finished.filter(node => !feedsSomething.has(node.id)).map(node => node.id);

    return { nodes: finished, rootIds, totalCpuUs, hotPath: findHotPath(byId, rootIds) };
}

/** CPU time of a node and everything feeding it, memoised, cycle-safe. */
function subtreeCpu(byId: Map<string, PlanGraphNode>, id: string, memo: Map<string, number>, seen: Set<string>): number {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return 0;

    seen.add(id);
    const node = byId.get(id);
    let total = node?.cpuUs ?? 0;
    for (const input of node?.inputs ?? []) total += subtreeCpu(byId, input, memo, seen);
    seen.delete(id);

    memo.set(id, total);
    return total;
}

function findHotPath(byId: Map<string, PlanGraphNode>, rootIds: string[]): string[] {
    const memo = new Map<string, number>();
    const heaviest = (ids: string[]): string | undefined =>
        [...ids].sort((a, b) => subtreeCpu(byId, b, memo, new Set()) - subtreeCpu(byId, a, memo, new Set()))[0];

    const path: string[] = [];
    const walked = new Set<string>();
    let current = heaviest(rootIds);
    while (current && !walked.has(current)) {
        path.push(current);
        walked.add(current);
        current = heaviest(byId.get(current)?.inputs ?? []);
    }
    return path;
}
