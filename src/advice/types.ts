/**
 * Advice drawn from what a query actually did.
 *
 * A lint rule reads the text and says a query looks wrong. These rules read the
 * measurements and say what this query, on this data, cost. That difference is
 * the whole point, so every finding carries the number that justifies it — a
 * severity without evidence is an opinion wearing a badge.
 */
import { Program } from '../parser/ast';
import { PlanSummary } from '../client/explain';
import { PlanGraph } from '../explain/graph';
import { QuerySummary } from '../explain/profile';

export type Importance = 'high' | 'medium' | 'low';

/** What a finding is about, so the editor can find it in the text later. */
export interface Subject {
    kind: 'function' | 'table' | 'column';
    name: string;
}

export interface Finding {
    ruleId: string;
    importance: Importance;
    title: string;
    /** The measurement behind it, stated plainly. */
    evidence: string;
    suggestion?: string;
    subject?: Subject;
    /** Set while a lazy lookup could still add to it. */
    pending?: boolean;
}

export interface AdviceContext {
    sql: string;
    program: Program;
    graph: PlanGraph;
    /** Index usage, as `EXPLAIN PLAN indexes = 1` reported it. */
    plan: PlanSummary;
    summary?: QuerySummary;
}

export interface AdviceRule {
    id: string;
    description: string;
    /** Everything a rule needs is already in hand; none of these ask the server. */
    run(context: AdviceContext): Finding[];
}
