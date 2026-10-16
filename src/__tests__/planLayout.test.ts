/**
 * Tests for plan layout geometry.
 *
 * Positions are fractions of the available space, never pixels, so the same
 * layout serves the panel at any width and the exported image at any size.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { buildPlanGraph, PlanGraph, ProcessorRow } from '../explain/graph';
import { dagLayout, flameLayout } from '../explain/view/layout';

function graphOf(spec: Array<[string, number, string[]]>): PlanGraph {
    // [step, cpu, feeds] — one processor each, which is enough for geometry.
    const idOf = new Map(spec.map(([step], index) => [step, String(index + 1)]));
    const rows: ProcessorRow[] = spec.map(([step, cpu, feeds]) => ({
        id: idOf.get(step)!,
        parent_ids: feeds.map(name => idOf.get(name)!),
        plan_step: '0',
        plan_step_name: step.replace(/_\d+$/, ''),
        plan_step_description: '',
        plan_group: 0,
        step_uniq_id: step,
        name: step,
        elapsed_us: cpu,
        input_wait_elapsed_us: 0,
        output_wait_elapsed_us: 0,
        input_rows: 0,
        input_bytes: 0,
        output_rows: 0,
        output_bytes: 0,
    }));
    return buildPlanGraph(rows);
}

function realGraph(): PlanGraph {
    const text = readFileSync(join(__dirname, 'fixtures', 'processors-profile.jsonl'), 'utf8');
    return buildPlanGraph(text.split('\n').filter(Boolean).map(line => JSON.parse(line) as ProcessorRow));
}

describe('flameLayout', () => {
    it('gives the sink the full width', () => {
        const cells = flameLayout(graphOf([['Sink_1', 100, []]]));
        expect(cells[0]).toMatchObject({ id: 'Sink_1', depth: 0, x: 0, width: 1 });
    });

    it('splits a parent by what each child subtree cost', () => {
        const cells = flameLayout(
            graphOf([
                ['Sink_1', 0, []],
                ['Heavy_1', 75, ['Sink_1']],
                ['Light_1', 25, ['Sink_1']],
            ])
        );

        expect(cells.find(cell => cell.id === 'Heavy_1')).toMatchObject({ depth: 1, width: 0.75 });
        expect(cells.find(cell => cell.id === 'Light_1')?.width).toBeCloseTo(0.25);
    });

    it('puts the heaviest child first, so the eye lands on it', () => {
        const cells = flameLayout(
            graphOf([
                ['Sink_1', 0, []],
                ['Light_1', 25, ['Sink_1']],
                ['Heavy_1', 75, ['Sink_1']],
            ])
        );

        const atDepthOne = cells.filter(cell => cell.depth === 1).sort((a, b) => a.x - b.x);
        expect(atDepthOne[0].id).toBe('Heavy_1');
        expect(atDepthOne[0].x).toBe(0);
    });

    it('leaves a gap under a node for the time it spent itself', () => {
        // Sink does half the work; only the other half is covered by its child.
        const cells = flameLayout(
            graphOf([
                ['Sink_1', 50, []],
                ['Child_1', 50, ['Sink_1']],
            ])
        );

        expect(cells.find(cell => cell.id === 'Child_1')?.width).toBeCloseTo(0.5);
    });

    it('nests a grandchild inside its parent, never wider', () => {
        const cells = flameLayout(
            graphOf([
                ['Sink_1', 0, []],
                ['Mid_1', 0, ['Sink_1']],
                ['Leaf_1', 100, ['Mid_1']],
            ])
        );

        const mid = cells.find(cell => cell.id === 'Mid_1')!;
        const leaf = cells.find(cell => cell.id === 'Leaf_1')!;
        expect(leaf.depth).toBe(2);
        expect(leaf.x).toBeGreaterThanOrEqual(mid.x);
        expect(leaf.x + leaf.width).toBeLessThanOrEqual(mid.x + mid.width + 1e-9);
    });

    it('marks the hot path so one chain can be emphasised', () => {
        const cells = flameLayout(
            graphOf([
                ['Sink_1', 10, []],
                ['Heavy_1', 90, ['Sink_1']],
            ])
        );

        expect(cells.find(cell => cell.id === 'Heavy_1')?.hot).toBe(true);
    });

    it('reports self time separately from subtree time', () => {
        const cells = flameLayout(
            graphOf([
                ['Sink_1', 50, []],
                ['Child_1', 50, ['Sink_1']],
            ])
        );

        const sink = cells.find(cell => cell.id === 'Sink_1')!;
        expect(sink.width).toBe(1);
        expect(sink.selfShare).toBeCloseTo(0.5);
    });

    it('lays out real ClickHouse output with the table read widest', () => {
        const cells = flameLayout(realGraph());
        const read = cells.find(cell => cell.label === 'ReadFromMergeTree')!;

        expect(read.width).toBeGreaterThan(0.6);
        for (const cell of cells) {
            expect(cell.x).toBeGreaterThanOrEqual(-1e-9);
            expect(cell.x + cell.width).toBeLessThanOrEqual(1 + 1e-9);
        }
    });
});

describe('dagLayout', () => {
    it('puts the sink at the top and what feeds it below', () => {
        const laid = dagLayout(
            graphOf([
                ['Sink_1', 10, []],
                ['Read_1', 90, ['Sink_1']],
            ])
        );

        expect(laid.nodes.find(node => node.id === 'Sink_1')?.depth).toBe(0);
        expect(laid.nodes.find(node => node.id === 'Read_1')?.depth).toBe(1);
    });

    it('pushes a node below every consumer it has, so no edge points upward', () => {
        // Shared_1 feeds both Mid_1 and Sink_1; it must sit below the deeper one.
        const laid = dagLayout(
            graphOf([
                ['Sink_1', 10, []],
                ['Mid_1', 10, ['Sink_1']],
                ['Shared_1', 80, ['Sink_1', 'Mid_1']],
            ])
        );

        const depthOf = (id: string): number => laid.nodes.find(node => node.id === id)!.depth;
        expect(depthOf('Shared_1')).toBeGreaterThan(depthOf('Mid_1'));
        for (const edge of laid.edges) {
            expect(depthOf(edge.from)).toBeGreaterThan(depthOf(edge.to));
        }
    });

    it('makes a node that burned more CPU visibly bigger', () => {
        const laid = dagLayout(
            graphOf([
                ['Sink_1', 1, []],
                ['Heavy_1', 99, ['Sink_1']],
            ])
        );

        const heavy = laid.nodes.find(node => node.id === 'Heavy_1')!;
        const sink = laid.nodes.find(node => node.id === 'Sink_1')!;
        expect(heavy.height).toBeGreaterThan(sink.height);
    });

    it('still gives a negligible node enough height to read', () => {
        const laid = dagLayout(
            graphOf([
                ['Sink_1', 1, []],
                ['Heavy_1', 99_999, ['Sink_1']],
            ])
        );

        expect(laid.nodes.find(node => node.id === 'Sink_1')!.height).toBeGreaterThan(0);
    });

    it('folds a run of negligible steps into one, so the shape stays readable', () => {
        const laid = dagLayout(
            graphOf([
                ['Sink_1', 500, []],
                ['Tiny_1', 1, ['Sink_1']],
                ['Tiny_2', 1, ['Tiny_1']],
                ['Read_1', 498, ['Tiny_2']],
            ])
        );

        const folded = laid.nodes.find(node => node.folded);
        expect(folded?.foldedCount).toBe(2);
        expect(laid.nodes).toHaveLength(3);
    });

    it('keeps the graph joined up after folding', () => {
        const laid = dagLayout(
            graphOf([
                ['Sink_1', 500, []],
                ['Tiny_1', 1, ['Sink_1']],
                ['Tiny_2', 1, ['Tiny_1']],
                ['Read_1', 498, ['Tiny_2']],
            ])
        );

        const ids = new Set(laid.nodes.map(node => node.id));
        for (const edge of laid.edges) {
            expect(ids.has(edge.from)).toBe(true);
            expect(ids.has(edge.to)).toBe(true);
        }
        // Sink is still reachable from the table read.
        expect(laid.edges.length).toBe(laid.nodes.length - 1);
    });

    it('never folds a step that did real work', () => {
        const laid = dagLayout(
            graphOf([
                ['Sink_1', 400, []],
                ['Middle_1', 200, ['Sink_1']],
                ['Read_1', 400, ['Middle_1']],
            ])
        );

        expect(laid.nodes.every(node => !node.folded)).toBe(true);
    });

    it('lays out real output with fewer boxes than there were steps', () => {
        const graph = realGraph();
        const laid = dagLayout(graph);

        expect(laid.nodes.length).toBeLessThan(graph.nodes.length);
        const tallest = [...laid.nodes].sort((a, b) => b.height - a.height)[0];
        expect(tallest.label).toBe('ReadFromMergeTree');
        for (const node of laid.nodes) {
            expect(node.x).toBeGreaterThanOrEqual(0);
            expect(node.x + node.width).toBeLessThanOrEqual(1 + 1e-9);
        }
    });
});

describe('folding runs of negligible steps', () => {
    const chain = (): PlanGraph =>
        graphOf([
            ['Sink_1', 500, []],
            ['Tiny_1', 1, ['Sink_1']],
            ['Tiny_2', 1, ['Tiny_1']],
            ['Tiny_3', 1, ['Tiny_2']],
            ['Read_1', 497, ['Tiny_3']],
        ]);

    it('takes the whole run, wherever the walk happens to start', () => {
        const folded = dagLayout(chain()).nodes.filter(node => node.folded);
        expect(folded).toHaveLength(1);
        expect(folded[0].foldedCount).toBe(3);
    });

    it('folds the flame too, so a long pipeline does not become a staircase', () => {
        const graph = chain();
        const cells = flameLayout(graph);
        expect(cells.length).toBeLessThan(graph.nodes.length);
        expect(cells.some(cell => cell.label === '3 minor steps')).toBe(true);
    });

    it('keeps the flame honest: a folded row is still as wide as its subtree', () => {
        const cells = flameLayout(chain());
        const read = cells.find(cell => cell.label === 'ReadFromMergeTree' || cell.id.includes('Read_1'));
        expect(read?.width).toBeCloseTo(497 / 1000, 2);
    });

    it('can be switched off when someone wants every step', () => {
        const graph = chain();
        expect(flameLayout(graph, { foldBelow: 0 })).toHaveLength(graph.nodes.length);
    });
});

describe('emphasis', () => {
    it('marks the one step that cost the most, not the whole chain', () => {
        // In a pipeline the hot path runs through every step, so outlining the
        // path outlines everything and says nothing. One bottleneck is the
        // thing a reader is looking for.
        const cells = flameLayout(
            graphOf([
                ['Sink_1', 5, []],
                ['Middle_1', 20, ['Sink_1']],
                ['Read_1', 300, ['Middle_1']],
            ])
        );

        expect(cells.filter(cell => cell.bottleneck).map(cell => cell.id)).toEqual(['Read_1']);
    });

    it('marks the bottleneck in the node-link view too', () => {
        const laid = dagLayout(
            graphOf([
                ['Sink_1', 5, []],
                ['Heavy_1', 300, ['Sink_1']],
            ])
        );

        expect(laid.nodes.filter(node => node.bottleneck).map(node => node.id)).toEqual(['Heavy_1']);
    });

    it('marks nothing when there is nothing to mark', () => {
        expect(flameLayout(graphOf([['Only_1', 0, []]])).filter(cell => cell.bottleneck)).toHaveLength(0);
    });
});

describe('reading a graph with several edges', () => {
    const forked = (): PlanGraph =>
        graphOf([
            ['Join_1', 100, []],
            ['ReadLeft_1', 400, ['Join_1']],
            ['ReadRight_1', 300, ['Join_1']],
        ]);

    it('numbers the steps in execution order, the sources first', () => {
        const laid = dagLayout(forked());
        const order = (id: string): number => laid.nodes.find(node => node.id === id)!.order;

        // The reads happen before the join that consumes them.
        expect(order('ReadLeft_1')).toBeLessThan(order('Join_1'));
        expect(order('ReadRight_1')).toBeLessThan(order('Join_1'));
    });

    it('gives the last step the highest number, so the order reads bottom to top', () => {
        const laid = dagLayout(forked());
        const highest = Math.max(...laid.nodes.map(node => node.order));
        expect(laid.nodes.find(node => node.order === highest)!.id).toBe('Join_1');
        expect(Math.min(...laid.nodes.map(node => node.order))).toBe(1);
    });

    it('lands each incoming edge on its own point, so they do not overlap', () => {
        const edges = dagLayout(forked()).edges.filter(edge => edge.to === 'Join_1');
        expect(edges).toHaveLength(2);
        expect(edges.map(edge => edge.slot).sort()).toEqual([0, 1]);
        expect(edges.every(edge => edge.slots === 2)).toBe(true);
    });

    it('gives a lone edge the whole width to land on', () => {
        const laid = dagLayout(
            graphOf([
                ['Sink_1', 10, []],
                ['Read_1', 90, ['Sink_1']],
            ])
        );
        expect(laid.edges[0]).toMatchObject({ slot: 0, slots: 1 });
    });

    it('carries the rows crossing each edge, so they can be told apart', () => {
        const laid = dagLayout(forked());
        expect(laid.edges.every(edge => typeof edge.rows === 'number')).toBe(true);
    });
});

describe('room for the arrows', () => {
    const deep = (): PlanGraph =>
        graphOf(
            Array.from({ length: 14 }, (_, i) => [
                `Step_${i}`,
                100 + i,
                i === 0 ? [] : [`Step_${i - 1}`],
            ]) as Array<[string, number, string[]]>
        );

    it('reports the gap between layers, so a renderer can size for it', () => {
        const laid = dagLayout(deep());
        expect(laid.gapFraction).toBeGreaterThan(0);
        expect(laid.gapFraction).toBeLessThan(1);
    });

    it('leaves a real gap even when the plan is deep', () => {
        const laid = dagLayout(deep());
        // Thirty-odd pixels is what an arrowhead and a visible line need.
        const heightNeeded = 36 / laid.gapFraction;
        expect(heightNeeded).toBeGreaterThan(0);
        expect(Number.isFinite(heightNeeded)).toBe(true);
    });

    it('never lets two layers touch', () => {
        const laid = dagLayout(deep());
        const byDepth = new Map<number, (typeof laid.nodes)[number]>();
        for (const node of laid.nodes) byDepth.set(node.depth, node);

        for (const [depth, node] of byDepth) {
            const below = byDepth.get(depth + 1);
            if (!below) continue;
            expect(below.y).toBeGreaterThan(node.y + node.height);
        }
    });
});

describe('what a bar sits under', () => {
    const joined = (): PlanGraph =>
        graphOf([
            ['Join_1', 50, []],
            ['BigRead_1', 400, ['Join_1']],
            ['SmallRead_1', 20, ['Join_1']],
        ]);

    it('records what each bar feeds, so a lone one can explain itself', () => {
        const cells = flameLayout(joined());
        expect(cells.find(cell => cell.id === 'SmallRead_1')?.feeds).toMatchObject({ label: 'Join' });
    });

    it('says how many inputs that consumer has, which is why there are two bars', () => {
        const cells = flameLayout(joined());
        expect(cells.find(cell => cell.id === 'SmallRead_1')?.feeds?.inputs).toBe(2);
        expect(cells.find(cell => cell.id === 'BigRead_1')?.feeds?.inputs).toBe(2);
    });

    it('leaves the sink with nothing to feed', () => {
        expect(flameLayout(joined()).find(cell => cell.id === 'Join_1')?.feeds).toBeUndefined();
    });
});
