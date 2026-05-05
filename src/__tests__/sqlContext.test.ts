/**
 * Tests for SQL context detection helpers.
 */
import { isClickHouseSQL, extractTableReferences, hasClause } from '../sqlContext';

describe('isClickHouseSQL', () => {
    it('detects MergeTree engine', () => {
        expect(isClickHouseSQL("CREATE TABLE t (id UInt64) ENGINE = MergeTree() ORDER BY id")).toBe(true);
    });

    it('detects PREWHERE', () => {
        expect(isClickHouseSQL("SELECT * FROM t PREWHERE x = 1")).toBe(true);
    });

    it('detects DateTime64 type', () => {
        expect(isClickHouseSQL("CREATE TABLE t (ts DateTime64(3))")).toBe(true);
    });

    it('detects toDateTime64 function', () => {
        expect(isClickHouseSQL("SELECT toDateTime64(ts, 3)")).toBe(true);
    });

    it('detects arrayJoin', () => {
        expect(isClickHouseSQL("SELECT arrayJoin([1,2,3])")).toBe(true);
    });

    it('returns false for plain SQL', () => {
        expect(isClickHouseSQL("SELECT * FROM users")).toBe(false);
    });

    it('returns false for empty string', () => {
        expect(isClickHouseSQL("")).toBe(false);
    });
});

describe('extractTableReferences', () => {
    it('extracts simple FROM table', () => {
        const refs = extractTableReferences("SELECT * FROM events");
        expect(refs).toHaveLength(1);
        expect(refs[0]).toEqual({ fullRef: 'events', table: 'events' });
    });

    it('extracts qualified FROM table', () => {
        const refs = extractTableReferences("SELECT * FROM db.events");
        expect(refs).toHaveLength(1);
        expect(refs[0]).toEqual({ fullRef: 'db.events', database: 'db', table: 'events' });
    });

    it('extracts FROM and JOIN tables', () => {
        const refs = extractTableReferences("SELECT * FROM a JOIN b ON a.id = b.id");
        expect(refs).toHaveLength(2);
        expect(refs[0].table).toBe('a');
        expect(refs[1].table).toBe('b');
    });
});

describe('hasClause', () => {
    it('detects ORDER BY', () => {
        expect(hasClause("SELECT * FROM t ORDER BY id", 'ORDER BY')).toBe(true);
    });

    it('detects GROUP BY', () => {
        expect(hasClause("SELECT x, count() FROM t GROUP BY x", 'GROUP BY')).toBe(true);
    });

    it('returns false for missing clause', () => {
        expect(hasClause("SELECT * FROM t", 'WHERE')).toBe(false);
    });
});
