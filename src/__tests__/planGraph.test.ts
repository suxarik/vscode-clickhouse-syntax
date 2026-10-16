/**
 * Tests for turning processor profile rows into a plan graph.
 *
 * The fixture is real output from ClickHouse 26.9: 54 processors for one
 * GROUP BY / ORDER BY / LIMIT query, captured with log_processors_profiles = 1.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { buildPlanGraph, ProcessorRow } from '../explain/graph';

function fixtureRows(): ProcessorRow[] {
    const text = readFileSync(join(__dirname, 'fixtures', 'processors-profile.jsonl'), 'utf8');
    return text
        .split('\n')
        .filter(line => line.trim())
        .map(line => JSON.parse(line) as ProcessorRow);
}

/** A tiny hand-built pipeline: two readers feed a filter, which feeds the sink. */
function row(over: Partial<ProcessorRow> & { id: string }): ProcessorRow {
    return {
        parent_ids: [],
        plan_step: '0',
        plan_step_name: '',
        plan_step_description: '',
        plan_group: 0,
        step_uniq_id: '',
        name: 'Processor',
        elapsed_us: 0,
        input_wait_elapsed_us: 0,
        output_wait_elapsed_us: 0,
        input_rows: 0,
        input_bytes: 0,
        output_rows: 0,
        output_bytes: 0,
        ...over,
    };
}

describe('buildPlanGraph', () => {
    it('collapses the processors of one step into a single node', () => {
        const graph = buildPlanGraph([
            row({ id: '1', step_uniq_id: 'Read_1', plan_step_name: 'ReadFromMergeTree', elapsed_us: 100 }),
            row({ id: '2', step_uniq_id: 'Read_1', plan_step_name: 'ReadFromMergeTree', elapsed_us: 300 }),
        ]);

        expect(graph.nodes).toHaveLength(1);
        expect(graph.nodes[0]).toMatchObject({
            id: 'Read_1',
            label: 'ReadFromMergeTree',
            processors: 2,
            cpuUs: 400,
        });
    });

    it('sums rows and wait time across the processors of a step', () => {
        const graph = buildPlanGraph([
            row({ id: '1', step_uniq_id: 'Agg_1', input_rows: 10, output_rows: 4, input_wait_elapsed_us: 7 }),
            row({ id: '2', step_uniq_id: 'Agg_1', input_rows: 20, output_rows: 6, output_wait_elapsed_us: 9 }),
        ]);

        expect(graph.nodes[0]).toMatchObject({
            inputRows: 30,
            outputRows: 10,
            inputWaitUs: 7,
            outputWaitUs: 9,
        });
    });

    it('gives a processor with no plan step a node of its own', () => {
        // LazyOutputFormat and NullSource belong to the pipeline, not to a step.
        const graph = buildPlanGraph([row({ id: '1', name: 'LazyOutputFormat' })]);

        expect(graph.nodes[0]).toMatchObject({ label: 'LazyOutputFormat', attached: false });
    });

    it('lifts processor edges to the step they belong to', () => {
        const graph = buildPlanGraph([
            row({ id: '1', step_uniq_id: 'Read_1', parent_ids: ['3'] }),
            row({ id: '2', step_uniq_id: 'Read_1', parent_ids: ['3'] }),
            row({ id: '3', step_uniq_id: 'Agg_1' }),
        ]);

        const agg = graph.nodes.find(node => node.id === 'Agg_1');
        // Two processor edges collapse to one step edge, pointing at what feeds it.
        expect(agg?.inputs).toEqual(['Read_1']);
    });

    it('does not draw a step feeding itself', () => {
        const graph = buildPlanGraph([
            row({ id: '1', step_uniq_id: 'Agg_1', parent_ids: ['2'] }),
            row({ id: '2', step_uniq_id: 'Agg_1' }),
        ]);

        expect(graph.nodes.find(node => node.id === 'Agg_1')?.inputs).toEqual([]);
    });

    it('finds the sink, which is the node that feeds nothing', () => {
        const graph = buildPlanGraph([
            row({ id: '1', step_uniq_id: 'Read_1', parent_ids: ['2'] }),
            row({ id: '2', step_uniq_id: 'Agg_1' }),
        ]);

        expect(graph.rootIds).toEqual(['Agg_1']);
    });

    it('gives each node its share of total CPU time', () => {
        const graph = buildPlanGraph([
            row({ id: '1', step_uniq_id: 'Read_1', elapsed_us: 750 }),
            row({ id: '2', step_uniq_id: 'Agg_1', elapsed_us: 250 }),
        ]);

        expect(graph.totalCpuUs).toBe(1000);
        expect(graph.nodes.find(node => node.id === 'Read_1')?.share).toBeCloseTo(0.75);
    });

    it('follows the heaviest subtree to find the hot path', () => {
        const graph = buildPlanGraph([
            row({ id: '1', step_uniq_id: 'Sink_1', elapsed_us: 10 }),
            row({ id: '2', step_uniq_id: 'Heavy_1', parent_ids: ['1'], elapsed_us: 900 }),
            row({ id: '3', step_uniq_id: 'Light_1', parent_ids: ['1'], elapsed_us: 20 }),
        ]);

        expect(graph.hotPath).toEqual(['Sink_1', 'Heavy_1']);
    });
});

describe('buildPlanGraph on real ClickHouse output', () => {
    const graph = buildPlanGraph(fixtureRows());

    it('collapses 54 processors into a readable number of steps', () => {
        expect(graph.nodes.length).toBeGreaterThan(3);
        expect(graph.nodes.length).toBeLessThan(15);
    });

    it('names the steps the plan actually used', () => {
        const labels = graph.nodes.map(node => node.label);
        expect(labels).toEqual(expect.arrayContaining(['ReadFromMergeTree', 'Aggregating', 'Sorting']));
    });

    it('puts the table read at the top of the hot path', () => {
        const hottest = [...graph.nodes].sort((a, b) => b.cpuUs - a.cpuUs)[0];
        expect(hottest.label).toBe('ReadFromMergeTree');
    });

    it('reaches every node from a sink, so nothing is orphaned', () => {
        const seen = new Set<string>();
        const walk = (id: string): void => {
            if (seen.has(id)) return;
            seen.add(id);
            for (const input of graph.nodes.find(node => node.id === id)?.inputs ?? []) walk(input);
        };
        for (const rootId of graph.rootIds) walk(rootId);
        expect(seen.size).toBe(graph.nodes.length);
    });
});

describe('buildPlanGraph on numbers the server quoted', () => {
    // The client asks ClickHouse to quote 64-bit integers, because JSON.parse
    // rounds anything past 2^53. Every counter therefore arrives as a string,
    // and adding those without meaning to concatenates them.
    const quoted = (over: Record<string, unknown>): ProcessorRow =>
        ({
            id: '1',
            parent_ids: [],
            plan_step: '0',
            plan_step_name: 'ReadFromMergeTree',
            plan_step_description: '',
            plan_group: 0,
            step_uniq_id: 'Read_1',
            name: 'MergeTreeSelect',
            elapsed_us: '0',
            input_wait_elapsed_us: '0',
            output_wait_elapsed_us: '0',
            input_rows: '0',
            input_bytes: '0',
            output_rows: '0',
            output_bytes: '0',
            ...over,
        }) as unknown as ProcessorRow;

    it('adds quoted counters instead of joining them', () => {
        const graph = buildPlanGraph([
            quoted({ id: '1', elapsed_us: '100' }),
            quoted({ id: '2', elapsed_us: '300' }),
        ]);

        expect(graph.nodes[0].cpuUs).toBe(400);
        expect(graph.totalCpuUs).toBe(400);
    });

    it('adds quoted row counts too', () => {
        const graph = buildPlanGraph([
            quoted({ id: '1', output_rows: '7', input_rows: '10' }),
            quoted({ id: '2', output_rows: '5', input_rows: '20' }),
        ]);

        expect(graph.nodes[0].outputRows).toBe(12);
        expect(graph.nodes[0].inputRows).toBe(30);
    });

    it('still computes a share rather than NaN', () => {
        const graph = buildPlanGraph([
            quoted({ id: '1', step_uniq_id: 'Read_1', elapsed_us: '750' }),
            quoted({ id: '2', step_uniq_id: 'Agg_1', elapsed_us: '250' }),
        ]);

        expect(graph.nodes.find(node => node.id === 'Read_1')?.share).toBeCloseTo(0.75);
    });
});
