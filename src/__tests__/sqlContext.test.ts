/**
 * Tests for SQL context detection.
 */
import {
    isClickHouseSQL,
    extractTableReferences,
    extractCteNames,
    hasClause,
    splitStatements,
    findSelectStar,
    findKeywordOccurrences,
    getSqlContextFromText,
} from '../sqlContext';

/** Context at the position marked by `|` in the query. */
function contextAt(sql: string) {
    const offset = sql.indexOf('|');
    if (offset < 0) throw new Error('mark the cursor with |');
    return getSqlContextFromText(sql.replace('|', ''), offset);
}

describe('isClickHouseSQL', () => {
    it('detects MergeTree engine', () => {
        expect(isClickHouseSQL('CREATE TABLE t (id UInt64) ENGINE = MergeTree() ORDER BY id')).toBe(true);
    });

    it('detects PREWHERE', () => {
        expect(isClickHouseSQL('SELECT * FROM t PREWHERE x = 1')).toBe(true);
    });

    it('detects DateTime64 type', () => {
        expect(isClickHouseSQL('CREATE TABLE t (ts DateTime64(3))')).toBe(true);
    });

    it('detects arrayJoin', () => {
        expect(isClickHouseSQL('SELECT arrayJoin([1,2,3])')).toBe(true);
    });

    it('returns false for plain SQL', () => {
        expect(isClickHouseSQL('SELECT * FROM users')).toBe(false);
    });

    it('returns false for empty input', () => {
        expect(isClickHouseSQL('')).toBe(false);
        expect(isClickHouseSQL('   \n  ')).toBe(false);
    });

    it('does not fire on prose inside comments', () => {
        expect(isClickHouseSQL('-- remember to use PREWHERE here\nSELECT * FROM users')).toBe(false);
    });

    it('does not fire on text inside string literals', () => {
        expect(isClickHouseSQL("SELECT 'PREWHERE' FROM users")).toBe(false);
    });
});

describe('getSqlContext clause detection', () => {
    it('reports the clause nearest the cursor, not the last one in a list', () => {
        // The regression that made AND/OR swallow every later clause.
        expect(contextAt('SELECT a FROM t WHERE x = 1 AND y = 2 ORDER BY |').clause).toBe('ORDER BY');
    });

    it('reports SELECT inside the select list', () => {
        expect(contextAt('SELECT a, | FROM t').clause).toBe('SELECT');
    });

    it('reports FROM after FROM', () => {
        expect(contextAt('SELECT a FROM |').clause).toBe('FROM');
    });

    it('reports WHERE inside a filter', () => {
        expect(contextAt('SELECT a FROM t WHERE |').clause).toBe('WHERE');
        expect(contextAt('SELECT a FROM t WHERE x = 1 AND |').clause).toBe('WHERE');
    });

    it('reports GROUP BY and HAVING separately', () => {
        expect(contextAt('SELECT a FROM t GROUP BY |').clause).toBe('GROUP BY');
        expect(contextAt('SELECT a FROM t GROUP BY a HAVING |').clause).toBe('HAVING');
    });

    it('reports the join clause', () => {
        expect(contextAt('SELECT a FROM t LEFT JOIN |').clause).toBe('LEFT JOIN');
        expect(contextAt('SELECT a FROM t LEFT JOIN u ON |').clause).toBe('ON');
    });

    it('reports PREWHERE', () => {
        expect(contextAt('SELECT a FROM t PREWHERE |').clause).toBe('PREWHERE');
    });

    it('uses the innermost subquery scope', () => {
        expect(contextAt('SELECT a FROM t WHERE id IN (SELECT |)').clause).toBe('SELECT');
        expect(contextAt('SELECT a FROM t WHERE id IN (SELECT id FROM |)').clause).toBe('FROM');
    });

    it('falls back to the enclosing clause inside a function call', () => {
        expect(contextAt('SELECT a FROM t WHERE toDate(|)').clause).toBe('WHERE');
    });

    it('reports the statement the cursor is in', () => {
        expect(contextAt('SELECT 1; SELECT a FROM t WHERE |').clause).toBe('WHERE');
    });

    it('reports strings and comments', () => {
        expect(contextAt("SELECT 'abc| def' FROM t").inString).toBe(true);
        expect(contextAt('-- comment | here\nSELECT 1').inComment).toBe(true);
        expect(contextAt('SELECT a FROM t WHERE |').inString).toBe(false);
    });

    it('tracks paren depth', () => {
        expect(contextAt('SELECT toDate(|) FROM t').depth).toBe(1);
        expect(contextAt('SELECT a | FROM t').depth).toBe(0);
    });
});

describe('getSqlContext scope', () => {
    it('collects tables with aliases', () => {
        const context = contextAt('SELECT | FROM analytics.events AS e JOIN users u ON e.id = u.id');
        expect(context.tables).toHaveLength(2);
        expect(context.tables[0]).toMatchObject({ database: 'analytics', table: 'events', alias: 'e' });
        expect(context.tables[1]).toMatchObject({ table: 'users', alias: 'u' });
    });

    it('does not treat a keyword after a table as an alias', () => {
        const context = contextAt('SELECT | FROM events FINAL WHERE x = 1');
        expect(context.tables[0].alias).toBeUndefined();
        expect(context.tables[0].table).toBe('events');
    });

    it('ignores table functions', () => {
        expect(contextAt('SELECT | FROM numbers(10)').tables).toHaveLength(0);
    });

    it('scopes tables to the subquery the cursor is in', () => {
        const context = contextAt('SELECT a FROM outer_t WHERE id IN (SELECT | FROM inner_t)');
        expect(context.tables.map(t => t.table)).toEqual(['inner_t']);
    });

    it('collects CTE names', () => {
        const context = contextAt('WITH recent AS (SELECT 1), older AS (SELECT 2) SELECT | FROM recent');
        expect(context.ctes).toEqual(['recent', 'older']);
    });
});

describe('extractTableReferences', () => {
    it('extracts a simple FROM table with its offset', () => {
        const refs = extractTableReferences('SELECT * FROM events');
        expect(refs).toHaveLength(1);
        expect(refs[0]).toMatchObject({ fullRef: 'events', table: 'events', start: 14 });
    });

    it('extracts a qualified table', () => {
        expect(extractTableReferences('SELECT * FROM db.events')[0]).toMatchObject({
            fullRef: 'db.events',
            database: 'db',
            table: 'events',
        });
    });

    it('extracts FROM and JOIN tables', () => {
        const refs = extractTableReferences('SELECT * FROM a JOIN b ON a.id = b.id');
        expect(refs.map(r => r.table)).toEqual(['a', 'b']);
    });

    it('points at the right occurrence when a name repeats', () => {
        const sql = 'SELECT events FROM events';
        expect(extractTableReferences(sql)[0].start).toBe(sql.lastIndexOf('events'));
    });

    it('ignores tables named inside strings', () => {
        expect(extractTableReferences("SELECT 'FROM ghost' FROM real_t").map(r => r.table)).toEqual(['real_t']);
    });
});

describe('extractCteNames', () => {
    it('finds CTE names', () => {
        expect(extractCteNames('WITH a AS (SELECT 1), b AS (SELECT 2) SELECT * FROM a')).toEqual(['a', 'b']);
    });

    it('ignores column aliases', () => {
        expect(extractCteNames('SELECT 1 AS x FROM t')).toEqual([]);
    });
});

describe('hasClause', () => {
    it('detects multi-word clauses', () => {
        expect(hasClause('SELECT * FROM t ORDER BY id', 'ORDER BY')).toBe(true);
        expect(hasClause('SELECT x, count() FROM t GROUP BY x', 'GROUP BY')).toBe(true);
    });

    it('returns false for a missing clause', () => {
        expect(hasClause('SELECT * FROM t', 'WHERE')).toBe(false);
    });

    it('ignores matches inside strings and comments', () => {
        expect(hasClause("SELECT 'WHERE' FROM t", 'WHERE')).toBe(false);
        expect(hasClause('-- WHERE\nSELECT * FROM t', 'WHERE')).toBe(false);
    });
});

describe('splitStatements', () => {
    it('splits on top-level semicolons', () => {
        const parts = splitStatements('SELECT 1; SELECT 2');
        expect(parts).toHaveLength(2);
        expect(parts[1].text.trim()).toBe('SELECT 2');
    });

    it('ignores semicolons inside strings', () => {
        expect(splitStatements("SELECT ';' FROM t")).toHaveLength(1);
    });
});

describe('findSelectStar', () => {
    it('finds SELECT *', () => {
        expect(findSelectStar('SELECT * FROM t')).toHaveLength(1);
    });

    it('finds SELECT DISTINCT *', () => {
        expect(findSelectStar('SELECT DISTINCT * FROM t')).toHaveLength(1);
    });

    it('does not match a multiplication', () => {
        expect(findSelectStar('SELECT a * b FROM t')).toHaveLength(0);
    });
});

describe('findKeywordOccurrences', () => {
    it('finds a multi-word phrase', () => {
        const hits = findKeywordOccurrences('SELECT * FROM t WHERE a NOT IN (1)', 'NOT IN');
        expect(hits).toHaveLength(1);
    });

    it('skips strings', () => {
        expect(findKeywordOccurrences("SELECT 'NOT IN' FROM t", 'NOT IN')).toHaveLength(0);
    });
});
