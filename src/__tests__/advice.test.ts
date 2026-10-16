/**
 * Tests for advice drawn from measurements.
 *
 * A lint rule can say a query looks wrong. These say what this query, on this
 * data, actually cost — so every finding has to carry the number that justifies
 * it, or it is just an opinion with a severity attached.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { advise, AdviceContext } from '../advice/engine';
import { buildPlanGraph, ProcessorRow } from '../explain/graph';
import { parsePlan, summarizePlan } from '../client/explain';
import { parse } from '../parser/parser';

function forkGraph() {
    const rows = readFileSync(join(__dirname, 'fixtures', 'processors-profile-fork.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as ProcessorRow);
    return buildPlanGraph(rows);
}

/** A graph where named steps carry the CPU shares a rule is meant to react to. */
function graphWith(steps: Array<[string, number]>) {
    const rows: ProcessorRow[] = steps.map(([label, cpu], index) => ({
        id: String(index + 1),
        parent_ids: index === 0 ? [] : [String(index)],
        plan_step: '0',
        plan_step_name: label,
        plan_step_description: '',
        plan_group: 0,
        step_uniq_id: `${label}_${index}`,
        name: label,
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

function context(over: Partial<AdviceContext> = {}): AdviceContext {
    const sql = 'SELECT user_id, count() FROM demo.events GROUP BY user_id';
    return {
        sql,
        program: parse(sql).program,
        graph: forkGraph(),
        plan: summarizePlan(parsePlan('ReadFromMergeTree (demo.events)')),
        summary: {
            query_duration_ms: 100,
            read_rows: 1000,
            read_bytes: 1000,
            result_rows: 100,
            memory_usage: 1000,
            threads: 8,
        },
        ...over,
    };
}

const PRUNED_NOTHING = `ReadFromMergeTree (demo.orders)
      Indexes:
        PrimaryKey
          Keys:
            user_id
          Condition: true
          Parts: 2/2
          Granules: 2104/2104`;

const PRUNED_WELL = `ReadFromMergeTree (demo.events)
      Indexes:
        PrimaryKey
          Keys:
            event_date
          Condition: (event_date in [20712, +Inf))
          Parts: 3/3
          Granules: 192/367`;

describe('advice from the plan', () => {
    it('reports an index that pruned nothing, and says so with the count', async () => {
        const findings = await advise(context({ plan: summarizePlan(parsePlan(PRUNED_NOTHING)) }));
        const finding = findings.find(f => f.ruleId === 'no-index-pruning');

        expect(finding).toBeDefined();
        expect(finding?.evidence).toContain('2104');
        expect(finding?.subject).toMatchObject({ kind: 'table', name: 'demo.orders' });
    });

    it('stays quiet when the index did its job', async () => {
        const findings = await advise(context({ plan: summarizePlan(parsePlan(PRUNED_WELL)) }));
        expect(findings.map(f => f.ruleId)).not.toContain('no-index-pruning');
    });

    it('notices an exact distinct that dominates the query', async () => {
        const sql = 'SELECT device, uniqExact(user_id) FROM demo.events GROUP BY device';
        const findings = await advise(
            context({
                sql,
                program: parse(sql).program,
                // An exact distinct is only worth questioning when it is the cost.
                graph: graphWith([
                    ['Aggregating', 800],
                    ['ReadFromMergeTree', 200],
                ]),
            })
        );
        const finding = findings.find(f => f.ruleId === 'exact-distinct-cost');

        expect(finding?.suggestion).toContain('uniq');
        expect(finding?.subject).toMatchObject({ kind: 'function', name: 'uniqExact' });
    });

    it('does not suggest uniq when the query never asked for exactness', async () => {
        const findings = await advise(
            context({ graph: graphWith([['Aggregating', 900], ['ReadFromMergeTree', 100]]) })
        );
        expect(findings.map(f => f.ruleId)).not.toContain('exact-distinct-cost');
    });

    it('leaves an exact distinct alone when it is not what cost the time', async () => {
        const sql = 'SELECT device, uniqExact(user_id) FROM demo.events GROUP BY device';
        const findings = await advise(
            context({
                sql,
                program: parse(sql).program,
                graph: graphWith([['ReadFromMergeTree', 950], ['Aggregating', 50]]),
            })
        );
        expect(findings.map(f => f.ruleId)).not.toContain('exact-distinct-cost');
    });

    it('reports reading far more than was returned', async () => {
        const findings = await advise(
            context({
                summary: {
                    query_duration_ms: 100,
                    read_rows: 10_000_000,
                    read_bytes: 1,
                    result_rows: 100,
                    memory_usage: 1,
                    threads: 8,
                },
            })
        );
        const finding = findings.find(f => f.ruleId === 'read-amplification');
        expect(finding?.evidence).toMatch(/10[.,]?0?0?\s?M|10000000/);
    });

    it('names the step that dominated, rather than saying the query is slow', async () => {
        const finding = (
            await advise(
                context({
                    graph: graphWith([
                        ['ReadFromMergeTree', 900],
                        ['Aggregating', 100],
                    ]),
                })
            )
        ).find(f => f.ruleId === 'dominant-step');
        expect(finding?.title).toContain('ReadFromMergeTree');
        expect(finding?.evidence).toMatch(/%/);
    });

    it('says when a query waited rather than computed', async () => {
        const findings = await advise(
            context({
                summary: {
                    query_duration_ms: 1000,
                    read_rows: 10,
                    read_bytes: 1,
                    result_rows: 10,
                    memory_usage: 1,
                    threads: 1,
                },
            })
        );
        expect(findings.map(f => f.ruleId)).toContain('mostly-waiting');
    });

    it('gives every finding the evidence that justifies it', async () => {
        const findings = await advise(context({ plan: summarizePlan(parsePlan(PRUNED_NOTHING)) }));
        expect(findings.length).toBeGreaterThan(0);
        for (const finding of findings) {
            expect(finding.evidence.length).toBeGreaterThan(0);
            expect(finding.title.length).toBeGreaterThan(0);
        }
    });

    it('can be stopped half way, so a new run abandons the old one', async () => {
        const controller = new AbortController();
        controller.abort();
        expect(await advise(context(), { signal: controller.signal })).toEqual([]);
    });

    it('reports findings as they are found, rather than only at the end', async () => {
        const batches: number[] = [];
        await advise(context({ plan: summarizePlan(parsePlan(PRUNED_NOTHING)) }), {
            onFindings: found => batches.push(found.length),
        });
        expect(batches.length).toBeGreaterThan(0);
    });
});
