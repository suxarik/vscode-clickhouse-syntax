/**
 * Tests for the code-action rewrites.
 */
import {
    caseToMultiIf,
    expandSelectStar,
    findIndexHintTarget,
    findPrewhereCandidate,
    findSelectStarTarget,
    moveToPrewhere,
    TextEdit,
} from '../refactors';

/** Apply an edit to the source it came from. */
function apply(text: string, edit: TextEdit | null): string | null {
    if (!edit) return null;
    return text.slice(0, edit.start) + edit.newText + text.slice(edit.end);
}

/** Offset of the `|` marker, with the marker removed. */
function mark(sql: string): { text: string; offset: number } {
    const offset = sql.indexOf('|');
    if (offset < 0) throw new Error('mark the cursor with |');
    return { text: sql.replace('|', ''), offset };
}

describe('findSelectStarTarget', () => {
    it('resolves the table behind the star', () => {
        const { text, offset } = mark('SELECT |* FROM analytics.events');
        expect(findSelectStarTarget(text, offset)?.table).toEqual({ database: 'analytics', table: 'events' });
    });

    it('handles SELECT DISTINCT *', () => {
        const { text, offset } = mark('SELECT DISTINCT |* FROM events');
        expect(findSelectStarTarget(text, offset)?.table).toEqual({ table: 'events' });
    });

    it('reports no table for a table function', () => {
        const { text, offset } = mark('SELECT |* FROM numbers(10)');
        expect(findSelectStarTarget(text, offset)?.table).toBeUndefined();
    });

    it('targets the statement the cursor is in', () => {
        const { text, offset } = mark('SELECT * FROM a; SELECT |* FROM b');
        expect(findSelectStarTarget(text, offset)?.table).toEqual({ table: 'b' });
    });
});

describe('expandSelectStar', () => {
    it('replaces the star with the column list', () => {
        const { text, offset } = mark('SELECT |* FROM events');
        expect(apply(text, expandSelectStar(text, offset, ['id', 'ts']))).toBe('SELECT id, ts FROM events');
    });

    it('only touches the statement the cursor is in', () => {
        const { text, offset } = mark('SELECT * FROM a; SELECT |* FROM b');
        expect(apply(text, expandSelectStar(text, offset, ['x']))).toBe('SELECT * FROM a; SELECT x FROM b');
    });

    it('returns null with no columns', () => {
        const { text, offset } = mark('SELECT |* FROM events');
        expect(expandSelectStar(text, offset, [])).toBeNull();
    });
});

describe('caseToMultiIf', () => {
    it('converts a two-branch CASE with ELSE', () => {
        const { text, offset } = mark("SELECT CASE WHEN a = 1 THEN 'one' WHEN a = 2 THEN 'two' ELSE 'other' |END FROM t");
        expect(apply(text, caseToMultiIf(text, offset))).toBe(
            "SELECT multiIf(a = 1, 'one', a = 2, 'two', 'other') FROM t"
        );
    });

    it('supplies NULL when there is no ELSE', () => {
        const { text, offset } = mark("SELECT CASE WHEN a |= 1 THEN 'one' END FROM t");
        expect(apply(text, caseToMultiIf(text, offset))).toBe("SELECT multiIf(a = 1, 'one', NULL) FROM t");
    });

    it('leaves a searched CASE with a subject alone', () => {
        const { text, offset } = mark("SELECT CASE a WHEN 1 |THEN 'one' END FROM t");
        expect(caseToMultiIf(text, offset)).toBeNull();
    });

    it('handles a nested CASE inside a branch', () => {
        const sql = "SELECT CASE WHEN a THEN CASE WHEN b THEN 1 ELSE 2 END ELSE 3 |END FROM t";
        const { text, offset } = mark(sql);
        expect(apply(text, caseToMultiIf(text, offset))).toBe(
            'SELECT multiIf(a, CASE WHEN b THEN 1 ELSE 2 END, 3) FROM t'
        );
    });

    it('returns null away from any CASE', () => {
        const { text, offset } = mark('SELECT a |FROM t');
        expect(caseToMultiIf(text, offset)).toBeNull();
    });
});

describe('moveToPrewhere', () => {
    it('moves the term under the cursor and keeps the rest', () => {
        const { text, offset } = mark('SELECT a FROM t WHERE |d = today() AND status = 1');
        expect(apply(text, moveToPrewhere(text, offset))).toBe(
            'SELECT a FROM t PREWHERE d = today() WHERE status = 1'
        );
    });

    it('keeps several remaining terms joined with AND', () => {
        const { text, offset } = mark('SELECT a FROM t WHERE |d = 1 AND b = 2 AND c = 3');
        expect(apply(text, moveToPrewhere(text, offset))).toBe(
            'SELECT a FROM t PREWHERE d = 1 WHERE b = 2 AND c = 3'
        );
    });

    it('stops before the next clause', () => {
        const { text, offset } = mark('SELECT a FROM t WHERE |d = 1 AND b = 2 ORDER BY a LIMIT 10');
        expect(apply(text, moveToPrewhere(text, offset))).toBe(
            'SELECT a FROM t PREWHERE d = 1 WHERE b = 2 ORDER BY a LIMIT 10'
        );
    });

    it('refuses a single-term WHERE, which would leave WHERE empty', () => {
        const { text, offset } = mark('SELECT a FROM t WHERE |d = 1');
        expect(moveToPrewhere(text, offset)).toBeNull();
    });

    it('refuses when a PREWHERE already exists', () => {
        const { text, offset } = mark('SELECT a FROM t PREWHERE x = 1 WHERE |d = 1 AND b = 2');
        expect(moveToPrewhere(text, offset)).toBeNull();
    });

    it('refuses when the filter contains a top-level OR', () => {
        const { text, offset } = mark('SELECT a FROM t WHERE |d = 1 OR b = 2');
        expect(moveToPrewhere(text, offset)).toBeNull();
    });

    it('ignores AND nested inside parentheses when splitting', () => {
        const { text, offset } = mark('SELECT a FROM t WHERE |d = 1 AND (b = 2 AND c = 3)');
        expect(apply(text, moveToPrewhere(text, offset))).toBe(
            'SELECT a FROM t PREWHERE d = 1 WHERE (b = 2 AND c = 3)'
        );
    });

    it('follows the casing of the existing WHERE', () => {
        const { text, offset } = mark('select a from t where |d = 1 and b = 2');
        expect(apply(text, moveToPrewhere(text, offset))).toBe('select a from t prewhere d = 1 where b = 2');
    });

    it('offers the term the cursor sits in, not always the first', () => {
        const { text, offset } = mark('SELECT a FROM t WHERE d = 1 AND st|atus = 2');
        expect(findPrewhereCandidate(text, offset)?.text).toBe('status = 2');
    });
});

describe('findIndexHintTarget', () => {
    it('wraps the equality term under the cursor', () => {
        const { text, offset } = mark('SELECT a FROM t WHERE us|er_id = 42 AND b = 1');
        expect(apply(text, findIndexHintTarget(text, offset))).toBe(
            'SELECT a FROM t WHERE indexHint(user_id = 42) AND b = 1'
        );
    });

    it('ignores a non-equality term', () => {
        const { text, offset } = mark('SELECT a FROM t WHERE us|er_id > 42 AND b = 1');
        expect(findIndexHintTarget(text, offset)).toBeNull();
    });

    it('does not wrap twice', () => {
        const { text, offset } = mark('SELECT a FROM t WHERE indexHi|nt(user_id = 42) AND b = 1');
        expect(findIndexHintTarget(text, offset)).toBeNull();
    });

    it('works inside PREWHERE', () => {
        const { text, offset } = mark('SELECT a FROM t PREWHERE us|er_id = 42 AND b = 1');
        expect(apply(text, findIndexHintTarget(text, offset))).toContain('indexHint(user_id = 42)');
    });
});
