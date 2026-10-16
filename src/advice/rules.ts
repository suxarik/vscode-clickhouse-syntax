/**
 * The rules.
 *
 * Each one needs only what an Analyze already collected, so the whole set runs
 * without another round trip. Anything that would need the server belongs to
 * the enrichment pass, which runs afterwards and never holds the plan up.
 */
import { walk } from '../parser/walk';
import { AdviceContext, AdviceRule, Finding } from './types';
import { formatCount } from '../results/format';

/** Share of CPU past which one step is worth naming on its own. */
const DOMINANT_SHARE = 0.6;
/** Share past which an exact distinct is worth questioning. */
const DISTINCT_SHARE = 0.35;
/** Rows read per row returned, past which the read is worth looking at. */
const AMPLIFICATION = 1000;

function percent(value: number): string {
    return `${(value * 100).toFixed(value >= 0.1 ? 0 : 1)}%`;
}

/** Every function called anywhere in the statement, lowercased. */
function functionsIn(context: AdviceContext): Map<string, string> {
    const found = new Map<string, string>();
    walk(context.program, node => {
        if (node.kind === 'FunctionCall') found.set(node.name.toLowerCase(), node.name);
    });
    return found;
}

export const ADVICE_RULES: AdviceRule[] = [
    {
        id: 'no-index-pruning',
        description: 'An index that removed nothing, so the whole table was read.',
        run(context): Finding[] {
            const findings: Finding[] = [];
            for (const index of context.plan.indexes) {
                const { granulesSelected, granulesTotal, table } = index;
                if (!granulesTotal || granulesSelected === undefined) continue;
                if (granulesSelected < granulesTotal) continue;

                findings.push({
                    ruleId: 'no-index-pruning',
                    importance: 'high',
                    title: `The index on ${table ?? 'this table'} removed nothing`,
                    evidence: `granules ${granulesSelected}/${granulesTotal}, parts ${index.partsSelected ?? '?'}/${index.partsTotal ?? '?'}`,
                    suggestion:
                        'The primary key does not cover what this query filters on. ' +
                        'A skip index on the filtered column, or a key that leads with it, would let ClickHouse skip granules.',
                    subject: table ? { kind: 'table', name: table } : undefined,
                    // The key itself costs a lookup, so it arrives later.
                    pending: true,
                });
            }
            return findings;
        },
    },

    {
        id: 'exact-distinct-cost',
        description: 'An exact distinct that took most of the query.',
        run(context): Finding[] {
            const functions = functionsIn(context);
            const exact = ['uniqexact', 'countdistinct', 'uniqthetasketch'].find(name => functions.has(name));
            if (!exact) return [];

            const aggregating = context.graph.nodes.find(node => /Aggregating/i.test(node.label));
            if (!aggregating || aggregating.share < DISTINCT_SHARE) return [];

            return [
                {
                    ruleId: 'exact-distinct-cost',
                    importance: 'medium',
                    title: `${functions.get(exact)} accounts for most of this query`,
                    evidence: `Aggregating used ${percent(aggregating.share)} of the query's CPU time`,
                    suggestion:
                        'uniq() is approximate, within a fraction of a percent, and costs far less memory and time. ' +
                        'Use it unless the count has to be exact.',
                    subject: { kind: 'function', name: functions.get(exact) ?? exact },
                },
            ];
        },
    },

    {
        id: 'read-amplification',
        description: 'Far more rows read than returned.',
        run(context): Finding[] {
            const summary = context.summary;
            if (!summary || summary.result_rows <= 0 || summary.read_rows <= 0) return [];
            const ratio = summary.read_rows / summary.result_rows;
            if (ratio < AMPLIFICATION) return [];

            return [
                {
                    ruleId: 'read-amplification',
                    importance: 'medium',
                    title: 'Most of what was read was thrown away',
                    evidence:
                        `read ${formatCount(summary.read_rows)} rows to return ` +
                        `${formatCount(summary.result_rows)}`,
                    suggestion:
                        'Narrow the filter so the server reads less, or move it into PREWHERE so the ' +
                        'columns it needs are read before the rest.',
                },
            ];
        },
    },

    {
        id: 'dominant-step',
        description: 'One step that took most of the query.',
        run(context): Finding[] {
            const heaviest = [...context.graph.nodes].sort((a, b) => b.cpuUs - a.cpuUs)[0];
            if (!heaviest || heaviest.share < DOMINANT_SHARE) return [];

            return [
                {
                    ruleId: 'dominant-step',
                    importance: 'low',
                    title: `${heaviest.label} is where the time went`,
                    evidence: `${percent(heaviest.share)} of the query's CPU time, across ${heaviest.processors} thread(s)`,
                    suggestion: 'Anything that makes this step cheaper will move the query; nothing else will.',
                },
            ];
        },
    },

    {
        id: 'mostly-waiting',
        description: 'A query that spent its time waiting rather than computing.',
        run(context): Finding[] {
            const summary = context.summary;
            if (!summary || summary.query_duration_ms <= 0) return [];

            const cpuMs = context.graph.totalCpuUs / 1000;
            if (cpuMs >= summary.query_duration_ms * 0.9) return [];

            return [
                {
                    ruleId: 'mostly-waiting',
                    importance: 'low',
                    title: 'This query waited more than it computed',
                    evidence: `${cpuMs.toFixed(0)} ms of CPU inside ${summary.query_duration_ms} ms of wall clock`,
                    suggestion:
                        'The time went somewhere other than processing — reading from disk or object storage, ' +
                        'a network round trip, or waiting on a lock. Making the computation faster will not help.',
                },
            ];
        },
    },
];
