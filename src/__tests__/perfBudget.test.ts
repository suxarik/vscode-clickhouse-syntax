/**
 * Tests for the performance report.
 *
 * The timings themselves belong to the integration suite, where they run in a
 * real extension host and fail the build if they regress. What is worth
 * checking here is the reporting: a budget that was not measured must not read
 * as one that passed.
 */
import { BUDGETS, formatMs, Measurement, renderReport, syntheticLines, syntheticSql, timeIt, verdictOf } from '../perf';

const budget = BUDGETS[0];

describe('verdicts', () => {
    it('is within budget at the limit, not just under it', () => {
        expect(verdictOf(budget, { id: budget.id, ms: budget.limit })).toBe('within');
        expect(verdictOf(budget, { id: budget.id, ms: budget.limit + 0.01 })).toBe('over');
    });

    it('distinguishes not measured from passed', () => {
        // The distinction is the point: a missing number is not a good one.
        expect(verdictOf(budget, undefined)).toBe('unmeasured');
        expect(verdictOf(budget, { id: budget.id })).toBe('unmeasured');
    });
});

describe('formatting', () => {
    it('shows as much precision as the number deserves', () => {
        expect(formatMs(1234)).toBe('1234 ms');
        expect(formatMs(45.67)).toBe('45.7 ms');
        expect(formatMs(1.234)).toBe('1.23 ms');
        expect(formatMs(0)).toBe('0.00 ms');
    });
});

describe('the report', () => {
    it('lists every budget, measured or not', () => {
        // A line missing from a report reads as a line that passed.
        const report = renderReport(new Map());
        for (const entry of BUDGETS) expect(report).toContain(entry.label);
        expect(report.match(/not measured/g)).toHaveLength(BUDGETS.length);
    });

    it('marks what is over budget, and counts it', () => {
        const measurements = new Map<string, Measurement>(
            BUDGETS.map(entry => [entry.id, { id: entry.id, ms: entry.limit * 2 }])
        );
        const report = renderReport(measurements);
        expect(report.match(/OVER/g)).toHaveLength(BUDGETS.length);
        expect(report).toContain(`${BUDGETS.length} measurements are over budget`);
    });

    it('says so plainly when everything passes', () => {
        const measurements = new Map<string, Measurement>(
            BUDGETS.map(entry => [entry.id, { id: entry.id, ms: 0.1 }])
        );
        const report = renderReport(measurements);
        expect(report).toContain('Everything measured is within budget.');
        expect(report).not.toContain('OVER');
    });

    it('does not call an unmeasured budget a pass', () => {
        const report = renderReport(new Map([['parse', { id: 'parse', ms: 1 }]]));
        expect(report).toContain('Everything measured is within budget.');
        // But the others are still visibly absent rather than silently dropped.
        expect(report).toContain('not measured');
    });

    it('uses the singular for one failure', () => {
        expect(renderReport(new Map([['parse', { id: 'parse', ms: 10_000 }]]))).toContain(
            '1 measurement is over budget'
        );
    });

    it('shows the sample count when a mean was taken', () => {
        const report = renderReport(new Map([['parse', { id: 'parse', ms: 1, samples: 5 }]]));
        expect(report).toContain('mean of 5');
        // A single sample is not worth saying.
        expect(renderReport(new Map([['parse', { id: 'parse', ms: 1, samples: 1 }]]))).not.toContain('mean of');
    });

    it('carries a measurement\'s note, which is where the caveats live', () => {
        const report = renderReport(new Map([['parse', { id: 'parse', ms: 1, note: 'no incremental path' }]]));
        expect(report).toContain('no incremental path');
    });

    it('appends whatever the caller wants to add', () => {
        expect(renderReport(new Map(), ['measured on this machine'])).toContain('measured on this machine');
    });
});

describe('the synthetic documents', () => {
    it('are about the size asked for', () => {
        expect(syntheticSql(10 * 1024).length).toBe(10 * 1024);
        expect(syntheticSql(100).length).toBe(100);
    });

    it('are real SQL rather than filler, so the parser does real work', () => {
        const text = syntheticSql(4096);
        expect(text).toContain('SELECT');
        expect(text).toContain('GROUP BY');
        expect(text.split(';').length).toBeGreaterThan(2);
    });

    it('produce the line count asked for', () => {
        expect(syntheticLines(5000).split('\n')).toHaveLength(5000);
        expect(syntheticLines(3).split('\n')).toHaveLength(3);
    });
});

describe('timing', () => {
    it('warms up before measuring, and averages', () => {
        let calls = 0;
        const result = timeIt(() => void calls++, 4);
        // Four samples plus one warm-up that is not counted.
        expect(calls).toBe(5);
        expect(result.samples).toBe(4);
        expect(result.ms).toBeGreaterThanOrEqual(0);
    });
});
