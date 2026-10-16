/**
 * Running the advice rules.
 *
 * Advice must never hold the plan up. The drawing is what someone asked for;
 * findings are a second opinion that arrives alongside it. So the engine yields
 * to the host between rules rather than running them in one block, reports each
 * batch as it is found rather than at the end, and abandons the run the moment
 * a newer one starts.
 */
import { ADVICE_RULES } from './rules';
import { AdviceContext, AdviceRule, Finding } from './types';

export * from './types';
export { ADVICE_RULES } from './rules';

export interface AdviceOptions {
    /** Aborted when a newer Analyze replaces this one. */
    signal?: AbortSignal;
    /** Called with each batch, so the panel fills in rather than waiting. */
    onFindings?: (findings: Finding[]) => void;
    disabled?: ReadonlySet<string>;
    rules?: AdviceRule[];
}

/** Hand the thread back, so a long rule set cannot stall typing. */
function yieldToHost(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0));
}

const ORDER = { high: 0, medium: 1, low: 2 };

export async function advise(context: AdviceContext, options: AdviceOptions = {}): Promise<Finding[]> {
    const rules = options.rules ?? ADVICE_RULES;
    const found: Finding[] = [];

    for (const rule of rules) {
        if (options.signal?.aborted) return [];
        if (options.disabled?.has(rule.id)) continue;

        let batch: Finding[] = [];
        try {
            batch = rule.run(context);
        } catch (error) {
            // One broken rule must not cost the reader the other findings.
            console.error(`ClickHouse: advice rule '${rule.id}' failed`, error);
        }

        if (batch.length > 0) {
            found.push(...batch);
            options.onFindings?.(batch);
        }
        await yieldToHost();
    }

    if (options.signal?.aborted) return [];
    return found.sort((a, b) => ORDER[a.importance] - ORDER[b.importance]);
}
