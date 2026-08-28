/**
 * Tests for the SQL formatter.
 */
import { formatSQL } from '../sqlFormatter';

const f = (sql: string, kw: string = 'upper', indent = 4) => formatSQL(sql, kw, indent);

describe('formatSQL', () => {
    it('formats basic SELECT', () => {
        const output = f('select a,b,c from t where x=1');
        expect(output).toBe(['SELECT', '    a,', '    b,', '    c', 'FROM t', 'WHERE', '    x = 1'].join('\n'));
    });

    it('preserves case when requested', () => {
        const output = f('select a from t', 'preserve');
        expect(output).toContain('select');
        expect(output).toContain('from');
    });

    it('lowercases keywords when requested', () => {
        const output = f('SELECT a FROM t', 'lower');
        expect(output).toContain('select');
        expect(output).toContain('from');
    });

    it('handles empty string', () => {
        expect(f('')).toBe('');
        expect(f('   ')).toBe('   ');
    });

    it('preserves string literals', () => {
        expect(f("SELECT name FROM t WHERE name = 'hello world'")).toContain("'hello world'");
    });

    it('does not touch keywords inside string literals', () => {
        expect(f("SELECT 'select from where' AS s")).toContain("'select from where'");
    });

    it('emits exactly one space after an inline clause keyword', () => {
        expect(f('SELECT a FROM t')).toContain('FROM t');
        expect(f('SELECT a FROM t')).not.toContain('FROM  t');
    });
});

describe('keyword casing safety', () => {
    it('leaves identifiers that collide with keywords alone', () => {
        const output = f('SELECT first, last, range, row, any_col FROM t WHERE set = 1');
        expect(output).toContain('first,');
        expect(output).toContain('last,');
        expect(output).toContain('range,');
        expect(output).toContain('row,');
        expect(output).toContain('set = 1');
        expect(output).not.toMatch(/\bFIRST\b/);
        expect(output).not.toMatch(/\bRANGE\b/);
        expect(output).not.toMatch(/\bSET\b/);
    });

    it('leaves real system-table column names alone', () => {
        const output = f('select database, table, engine, partition, comment, type from system.parts');
        for (const column of ['database', 'table', 'engine', 'partition', 'comment', 'type']) {
            expect(output).toContain(column);
        }
        expect(output).toContain('FROM system.parts');
    });

    it('does not uppercase function names that collide with keywords', () => {
        const output = f('select left(s,2), right(s,2), any(x), if(a,b,c), count() from t');
        expect(output).toContain('left(s, 2)');
        expect(output).toContain('right(s, 2)');
        expect(output).toContain('any(x)');
        expect(output).toContain('if(a, b, c)');
    });

    it('cases END only when it closes a CASE', () => {
        const output = f("select case when a=1 then 'x' else 'y' end as label, end_time from t");
        expect(output).toContain('END AS label');
        expect(output).toContain('end_time');
    });

    it('cases FORMAT only in front of a format name', () => {
        expect(f('select * from t format JSONEachRow')).toContain('FORMAT JSONEachRow');
        expect(f('select format from t')).toContain('format');
        expect(f('select format from t')).not.toMatch(/\bFORMAT\b/);
    });

    it('cases SET only where it is a keyword', () => {
        expect(f('ALTER TABLE t UPDATE x = 1 WHERE y = 2')).toContain('UPDATE');
        expect(f('select set from t')).toContain('set');
    });

    it('never cases a qualified name part', () => {
        expect(f('select t.range, t.row from t')).toContain('t.range');
        expect(f('select t.range, t.row from t')).toContain('t.row');
    });
});

describe('structure', () => {
    it('formats CTE bodies', () => {
        const output = f('WITH x AS (SELECT a, b FROM t WHERE a > 1 AND b < 2) SELECT * FROM x');
        expect(output).toBe(
            [
                'WITH',
                '    x AS (',
                '        SELECT',
                '            a,',
                '            b',
                '        FROM t',
                '        WHERE',
                '            a > 1',
                '            AND b < 2',
                '    )',
                'SELECT',
                '    *',
                'FROM x',
            ].join('\n')
        );
    });

    it('formats subqueries inside WHERE', () => {
        const output = f('select a from t where id in (select id from u where x=1) and z=3');
        expect(output).toContain('    id IN (');
        expect(output).toContain('        SELECT');
        expect(output).toContain('    AND z = 3');
    });

    it('formats CREATE TABLE column lists', () => {
        const output = f(
            "CREATE TABLE db.t (a UInt64, b String DEFAULT '', c DateTime CODEC(Delta, ZSTD)) " +
                'ENGINE = MergeTree PARTITION BY toYYYYMM(c) ORDER BY (a, c) SETTINGS index_granularity = 8192'
        );
        expect(output).toContain('CREATE TABLE db.t\n(\n    a UInt64,');
        expect(output).toContain('CODEC(Delta, ZSTD)');
        expect(output).toContain('ENGINE = MergeTree');
        expect(output).toContain('ORDER BY (a, c)');
        expect(output).not.toContain('ORDER BY\n');
    });

    it('formats INSERT ... VALUES', () => {
        const output = f("INSERT INTO t (a, b) VALUES (1,'x'),(2,'y')");
        expect(output).toBe(['INSERT INTO t (a, b)', 'VALUES', "    (1, 'x'),", "    (2, 'y')"].join('\n'));
    });

    it('keeps JOIN conditions readable', () => {
        const output = f('select a.x from a inner join b on a.id=b.id and a.d=b.d where a.z>1');
        expect(output).toContain('INNER JOIN b\n    ON a.id = b.id\n    AND a.d = b.d');
    });

    it('keeps array literals on one line', () => {
        expect(f('select [1,2,3], arr[1] from t')).toContain('[1, 2, 3]');
        expect(f('select [1,2,3], arr[1] from t')).toContain('arr[1]');
    });

    it('keeps window specs on one line', () => {
        const output = f('SELECT sum(x) OVER (PARTITION BY a ORDER BY b) FROM t');
        expect(output).toContain('sum(x) OVER (PARTITION BY a ORDER BY b)');
    });

    it('keeps parameterised aggregates tight', () => {
        expect(f('select topK(5)(user_id) from events')).toContain('topK(5)(user_id)');
    });

    it('separates multiple statements', () => {
        expect(f('select 1; select 2')).toBe('SELECT\n    1;\n\nSELECT\n    2');
    });

    it('handles unary minus', () => {
        const output = f('select -1, a - b, -x + 2 from t');
        expect(output).toContain('-1,');
        expect(output).toContain('a - b,');
        expect(output).toContain('-x + 2');
    });
});

describe('comments', () => {
    it('keeps block comments', () => {
        expect(f('SELECT a FROM t /* comment */ WHERE x = 1')).toContain('/* comment */');
    });

    it('keeps trailing line comments on their line', () => {
        const output = f('SELECT a, -- first col\n b FROM t\nWHERE x=1');
        expect(output).toContain('a, -- first col');
        expect(output).toContain('    b');
    });

    it('does not treat keywords inside comments as keywords', () => {
        expect(f('-- select from where\nSELECT a FROM t')).toContain('-- select from where');
    });
});

describe('idempotency', () => {
    const corpus = [
        'select a,b,c from t where x=1 and y=2 order by a desc limit 10',
        'WITH x AS (SELECT a FROM t WHERE a > 1) SELECT * FROM x',
        'select a from t where id in (select id from u) and z=3',
        "CREATE TABLE db.t (a UInt64, b String DEFAULT '') ENGINE = MergeTree ORDER BY a",
        "INSERT INTO t (a, b) VALUES (1,'x'),(2,'y')",
        'select a.x, b.y from a inner join b on a.id=b.id left join c on c.id=a.id',
        'SELECT sum(x) OVER (PARTITION BY a ORDER BY b ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) FROM t',
        "select case when a=1 then 'one' else 'two' end as label from t",
        'select 1; select 2; select 3',
        'SELECT a, -- note\n b FROM t',
        'select groupArray(x), topK(5)(y), quantiles(0.5, 0.9)(z) from t group by k having count() > 10',
        'select * from t final sample 0.1 prewhere d = today() where x = 1 format JSONEachRow',
        'select arrayMap(x -> x * 2, [1,2,3]) as doubled from numbers(10)',
        'select * from a union all select * from b',
        "select toStartOfInterval(ts, INTERVAL 5 MINUTE) as bucket, count() from events group by bucket",
    ];

    for (const sql of corpus) {
        it(`is stable for: ${sql.slice(0, 48)}…`, () => {
            const once = f(sql);
            expect(f(once)).toBe(once);
        });
    }
});
