/**
 * Measuring the performance budget, so a regression is visible rather than felt.
 *
 * The plan sets four numbers: activation under 150 ms, a full re-parse of 100 KB
 * under 20 ms, an incremental re-parse under 5 ms, and completion under 50 ms on
 * a 5000-line document. A budget nobody can check is a wish, so this runs the
 * measurements on demand, in the real extension host, and reports each against
 * its number.
 *
 * The measuring is kept apart from `vscode` so it can be tested as arithmetic.
 */

export interface Budget {
    id: string;
    label: string;
    /** Milliseconds this must stay under. */
    limit: number;
    detail: string;
}

/** A large-but-real SQL file. 100 KB is a stress test, not a working document. */
export const TYPICAL_KB = 20;

export const BUDGETS: Budget[] = [
    { id: 'activation', label: 'Activation', limit: 150, detail: 'Measured at startup, once.' },
    { id: 'parse', label: 'Full re-parse of 100 KB', limit: 20, detail: 'Lexer, parser and binder, on a stress-test document.' },
    {
        id: 'reparse',
        label: `Re-analysis after one edit (${TYPICAL_KB} KB)`,
        limit: 5,
        detail:
            'What a keystroke costs on a large-but-real file. There is no incremental ' +
            'path: analysis is linear in document size and cached per document version.',
    },
    {
        id: 'completion',
        label: 'Completion on 5000 lines',
        limit: 50,
        detail: 'Context, scope and candidate building.',
    },
];

export interface Measurement {
    id: string;
    /** Milliseconds, or undefined when it could not be measured this session. */
    ms?: number;
    /** How many times it was run, when an average was taken. */
    samples?: number;
    note?: string;
}

export type Verdict = 'within' | 'over' | 'unmeasured';

export function verdictOf(budget: Budget, measurement: Measurement | undefined): Verdict {
    if (!measurement || measurement.ms === undefined) return 'unmeasured';
    return measurement.ms <= budget.limit ? 'within' : 'over';
}

/** Two significant figures is as much precision as any of this deserves. */
export function formatMs(ms: number): string {
    if (ms >= 100) return `${Math.round(ms)} ms`;
    if (ms >= 10) return `${ms.toFixed(1)} ms`;
    return `${ms.toFixed(2)} ms`;
}

/**
 * Render the report.
 *
 * Every budget appears, whether it was measured or not: a line missing from a
 * report reads as a line that passed.
 */
export function renderReport(measurements: Map<string, Measurement>, extras: string[] = []): string {
    const lines = ['ClickHouse performance budget', ''];
    let over = 0;

    for (const budget of BUDGETS) {
        const measurement = measurements.get(budget.id);
        const verdict = verdictOf(budget, measurement);
        if (verdict === 'over') over++;

        const mark = verdict === 'within' ? 'ok  ' : verdict === 'over' ? 'OVER' : '  ? ';
        const actual =
            measurement?.ms === undefined ? 'not measured' : formatMs(measurement.ms).padStart(9);
        const samples = measurement?.samples && measurement.samples > 1 ? ` (mean of ${measurement.samples})` : '';
        lines.push(`  ${mark}  ${budget.label.padEnd(28)} ${actual}   budget ${formatMs(budget.limit)}${samples}`);
        if (measurement?.note) lines.push(`        ${measurement.note}`);
    }

    lines.push('', ...BUDGETS.map(budget => `  ${budget.label}: ${budget.detail}`));
    if (extras.length > 0) lines.push('', ...extras);
    lines.push(
        '',
        over === 0
            ? 'Everything measured is within budget.'
            : `${over} measurement${over === 1 ? ' is' : 's are'} over budget.`
    );
    return lines.join('\n');
}

/** Time one call, returning the mean over `samples` runs. */
export function timeIt(run: () => void, samples = 5): Measurement & { ms: number } {
    // One warm-up, so the first JIT pass is not the measurement.
    run();
    const started = performance.now();
    for (let i = 0; i < samples; i++) run();
    return { id: '', ms: (performance.now() - started) / samples, samples };
}

/** A document of roughly `bytes` bytes of plausible SQL. */
export function syntheticSql(bytes: number): string {
    const block = [
        'SELECT',
        '    event_date,',
        '    user_id,',
        '    count() AS events,',
        '    uniqExact(session_id) AS sessions',
        'FROM analytics.events',
        "WHERE event_date >= today() - 30 AND event_type = 'click'",
        'GROUP BY event_date, user_id',
        'ORDER BY events DESC',
        'LIMIT 100;',
        '',
    ].join('\n');
    const repeats = Math.max(1, Math.ceil(bytes / block.length));
    return block.repeat(repeats).slice(0, bytes);
}

/** A document of roughly `lines` lines, for the completion measurement. */
export function syntheticLines(lines: number): string {
    const text = syntheticSql(lines * 40);
    const split = text.split('\n');
    while (split.length < lines) split.push('-- filler');
    return split.slice(0, lines).join('\n');
}
