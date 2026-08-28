/**
 * Tests for the ClickHouse SQL parser.
 */
import { parse, parseExpressionText } from '../parser/parser';
import {
    Binary,
    CaseExpression,
    CreateTableStatement,
    FunctionCall,
    InsertStatement,
    Lambda,
    SelectStatement,
    Star,
    Subscript,
} from '../parser/ast';

/** First statement, typed. */
function first<T>(sql: string): T {
    return parse(sql).program.statements[0] as unknown as T;
}

function diagnostics(sql: string): string[] {
    return parse(sql).diagnostics.map(d => d.message);
}

describe('select structure', () => {
    it('parses columns, aliases and the source', () => {
        const select = first<SelectStatement>('SELECT a, b AS c FROM analytics.events');
        expect(select.columns).toHaveLength(2);
        expect(select.columns[1].alias?.name).toBe('c');
        expect(select.from?.source).toMatchObject({
            kind: 'TableRef',
            table: { name: 'events' },
            database: { name: 'analytics' },
        });
    });

    it('parses DISTINCT', () => {
        expect(first<SelectStatement>('SELECT DISTINCT a FROM t').distinct).toBe(true);
        expect(first<SelectStatement>('SELECT a FROM t').distinct).toBe(false);
    });

    it('parses every clause', () => {
        const select = first<SelectStatement>(
            'SELECT a FROM t PREWHERE p = 1 WHERE w = 2 GROUP BY a HAVING h > 3 ' +
                'ORDER BY a DESC LIMIT 10 OFFSET 5 SETTINGS max_threads = 4 FORMAT JSONEachRow'
        );
        expect(select.prewhere).toBeDefined();
        expect(select.where).toBeDefined();
        expect(select.groupBy).toHaveLength(1);
        expect(select.having).toBeDefined();
        expect(select.orderBy[0].direction).toBe('DESC');
        expect(select.limit).toBeDefined();
        expect(select.offset).toBeDefined();
        expect(select.settings[0].name.name).toBe('max_threads');
        expect(select.format?.name).toBe('JSONEachRow');
    });

    it('parses GROUP BY modifiers', () => {
        expect(first<SelectStatement>('SELECT a FROM t GROUP BY a WITH TOTALS').groupByModifier).toBe('WITH TOTALS');
        expect(first<SelectStatement>('SELECT a FROM t GROUP BY a WITH ROLLUP').groupByModifier).toBe('WITH ROLLUP');
    });

    it('parses LIMIT BY', () => {
        const select = first<SelectStatement>('SELECT a FROM t LIMIT 3 BY user_id');
        expect(select.limitBy?.by).toHaveLength(1);
    });

    it('reads LIMIT offset, count in the right order', () => {
        const select = first<SelectStatement>('SELECT a FROM t LIMIT 10, 20');
        expect((select.offset as { text: string }).text).toBe('10');
        expect((select.limit as { text: string }).text).toBe('20');
    });

    it('parses ORDER BY modifiers', () => {
        const select = first<SelectStatement>('SELECT a FROM t ORDER BY a DESC NULLS LAST, b ASC');
        expect(select.orderBy[0]).toMatchObject({ direction: 'DESC', nulls: 'LAST' });
        expect(select.orderBy[1].direction).toBe('ASC');
    });

    it('parses set operations', () => {
        const select = first<SelectStatement>('SELECT a FROM x UNION ALL SELECT b FROM y');
        expect(select.setOperations).toHaveLength(1);
        expect(select.setOperations[0].operator).toBe('UNION ALL');
        expect(select.setOperations[0].select.columns[0].expression).toMatchObject({ name: 'b' });
    });

    it('parses multiple statements', () => {
        const program = parse('SELECT 1; SELECT 2; SELECT 3').program;
        expect(program.statements).toHaveLength(3);
    });
});

describe('FROM and joins', () => {
    it('parses aliases with and without AS', () => {
        const select = first<SelectStatement>('SELECT a FROM t AS x JOIN u y ON x.id = y.id');
        expect(select.from?.source).toMatchObject({ alias: { name: 'x' } });
        expect(select.from?.joins[0].source).toMatchObject({ alias: { name: 'y' } });
    });

    it('parses FINAL', () => {
        expect(first<SelectStatement>('SELECT a FROM t FINAL').from?.source).toMatchObject({ final: true });
        expect(first<SelectStatement>('SELECT a FROM t AS x FINAL').from?.source).toMatchObject({
            final: true,
            alias: { name: 'x' },
        });
    });

    it('records the join type', () => {
        expect(first<SelectStatement>('SELECT a FROM t LEFT JOIN u ON 1').from?.joins[0].joinType).toBe('LEFT JOIN');
        expect(first<SelectStatement>('SELECT a FROM t LEFT ANY JOIN u ON 1').from?.joins[0].joinType).toBe(
            'LEFT ANY JOIN'
        );
        expect(first<SelectStatement>('SELECT a FROM t ASOF JOIN u ON 1').from?.joins[0].joinType).toBe('ASOF JOIN');
    });

    it('parses USING', () => {
        const join = first<SelectStatement>('SELECT a FROM t JOIN u USING (id, day)').from?.joins[0];
        expect(join?.using?.map(u => u.name)).toEqual(['id', 'day']);
    });

    it('parses a comma join', () => {
        const select = first<SelectStatement>('SELECT a FROM t, u');
        expect(select.from?.joins[0].joinType).toBe('CROSS JOIN');
    });

    it('parses a subquery source', () => {
        const select = first<SelectStatement>('SELECT a FROM (SELECT b FROM inner_t) AS s');
        expect(select.from?.source).toMatchObject({ kind: 'SubquerySource', alias: { name: 's' } });
    });

    it('parses a table function source', () => {
        const select = first<SelectStatement>('SELECT a FROM numbers(10) AS n');
        expect(select.from?.source).toMatchObject({ kind: 'TableFunctionSource', alias: { name: 'n' } });
    });

    it('parses ARRAY JOIN with aliases', () => {
        const select = first<SelectStatement>('SELECT tag FROM t ARRAY JOIN tags AS tag, nums');
        expect(select.from?.arrayJoin?.items).toHaveLength(2);
        expect(select.from?.arrayJoin?.items[0].alias?.name).toBe('tag');
        expect(select.from?.arrayJoin?.left).toBe(false);
    });

    it('parses LEFT ARRAY JOIN', () => {
        expect(first<SelectStatement>('SELECT a FROM t LEFT ARRAY JOIN tags').from?.arrayJoin?.left).toBe(true);
    });
});

describe('CTEs', () => {
    it('parses a subquery CTE', () => {
        const select = first<SelectStatement>('WITH recent AS (SELECT id FROM t) SELECT * FROM recent');
        expect(select.ctes).toHaveLength(1);
        expect(select.ctes[0].name.name).toBe('recent');
        expect(select.ctes[0].select?.columns).toHaveLength(1);
    });

    it('parses several CTEs', () => {
        const select = first<SelectStatement>('WITH a AS (SELECT 1), b AS (SELECT 2) SELECT * FROM a');
        expect(select.ctes.map(c => c.name.name)).toEqual(['a', 'b']);
    });

    it('parses a scalar CTE', () => {
        const select = first<SelectStatement>('WITH 42 AS answer SELECT answer');
        expect(select.ctes[0].name.name).toBe('answer');
        expect(select.ctes[0].expression).toMatchObject({ kind: 'NumberLiteral' });
    });
});

describe('expressions', () => {
    it('respects operator precedence', () => {
        const expression = parseExpressionText('a = 1 AND b = 2 OR c = 3') as Binary;
        expect(expression.operator).toBe('OR');
        expect((expression.left as Binary).operator).toBe('AND');
    });

    it('binds arithmetic tighter than comparison', () => {
        const expression = parseExpressionText('a + b * c > d') as Binary;
        expect(expression.operator).toBe('>');
        expect((expression.left as Binary).operator).toBe('+');
        expect(((expression.left as Binary).right as Binary).operator).toBe('*');
    });

    it('parses IS NULL and IS NOT NULL', () => {
        expect((parseExpressionText('a IS NULL') as Binary).operator).toBe('IS NULL');
        expect((parseExpressionText('a IS NOT NULL') as Binary).operator).toBe('IS NOT NULL');
    });

    it('parses the negated and global membership operators', () => {
        expect((parseExpressionText('a NOT IN (1)') as Binary).operator).toBe('NOT IN');
        expect((parseExpressionText('a GLOBAL IN (1)') as Binary).operator).toBe('GLOBAL IN');
        expect((parseExpressionText('a GLOBAL NOT IN (1)') as Binary).operator).toBe('GLOBAL NOT IN');
        expect((parseExpressionText('a NOT LIKE \'x\'') as Binary).operator).toBe('NOT LIKE');
    });

    it('parses BETWEEN as one operator', () => {
        const expression = parseExpressionText('a BETWEEN 1 AND 2') as Binary;
        expect(expression.operator).toBe('BETWEEN');
        expect(expression.right).toMatchObject({ kind: 'Tuple' });
    });

    it('parses unary operators', () => {
        expect(parseExpressionText('-1')).toMatchObject({ kind: 'Unary', operator: '-' });
        expect(parseExpressionText('NOT a')).toMatchObject({ kind: 'Unary', operator: 'NOT' });
    });

    it('parses function calls', () => {
        const call = parseExpressionText('toDate(x, 2)') as FunctionCall;
        expect(call.name).toBe('toDate');
        expect(call.args).toHaveLength(2);
    });

    it('parses parameterised aggregates', () => {
        const call = parseExpressionText('quantile(0.5)(x)') as FunctionCall;
        expect(call.name).toBe('quantile');
        expect(call.parameters).toHaveLength(1);
        expect(call.args).toHaveLength(1);
    });

    it('parses count(DISTINCT x)', () => {
        const call = parseExpressionText('count(DISTINCT x)') as FunctionCall;
        expect(call.distinct).toBe(true);
    });

    it('parses window functions', () => {
        const call = parseExpressionText('sum(x) OVER (PARTITION BY a ORDER BY b)') as FunctionCall;
        expect(call.over).toMatchObject({ kind: 'WindowDefinition' });
        const named = parseExpressionText('sum(x) OVER w') as FunctionCall;
        expect(named.over).toMatchObject({ kind: 'Identifier', name: 'w' });
    });

    it('parses lambdas', () => {
        const call = parseExpressionText('arrayMap(x -> x * 2, arr)') as FunctionCall;
        const lambda = call.args[0] as Lambda;
        expect(lambda.kind).toBe('Lambda');
        expect(lambda.params.map(p => p.name)).toEqual(['x']);
    });

    it('parses multi-parameter lambdas', () => {
        const call = parseExpressionText('arrayMap((x, y) -> x + y, a, b)') as FunctionCall;
        expect((call.args[0] as Lambda).params.map(p => p.name)).toEqual(['x', 'y']);
    });

    it('parses CASE in both forms', () => {
        const searched = parseExpressionText("CASE WHEN a THEN 1 ELSE 2 END") as CaseExpression;
        expect(searched.subject).toBeUndefined();
        expect(searched.branches).toHaveLength(1);
        expect(searched.else).toBeDefined();

        const simple = parseExpressionText('CASE a WHEN 1 THEN 2 END') as CaseExpression;
        expect(simple.subject).toMatchObject({ name: 'a' });
    });

    it('parses arrays, tuples and subscripts', () => {
        expect(parseExpressionText('[1, 2, 3]')).toMatchObject({ kind: 'ArrayLiteral' });
        expect(parseExpressionText('(1, 2)')).toMatchObject({ kind: 'Tuple' });
        expect((parseExpressionText('arr[1]') as Subscript).kind).toBe('Subscript');
        expect((parseExpressionText('t.1') as Subscript).kind).toBe('Subscript');
    });

    it('parses casts', () => {
        expect(parseExpressionText('x::UInt64')).toMatchObject({ kind: 'CastExpression', typeText: 'UInt64' });
    });

    it('parses intervals', () => {
        expect(parseExpressionText('INTERVAL 3 DAY')).toMatchObject({ kind: 'IntervalExpression', unit: 'DAY' });
    });

    it('parses qualified names', () => {
        expect(parseExpressionText('db.t.col')).toMatchObject({ kind: 'Qualified' });
    });

    it('parses stars', () => {
        const select = first<SelectStatement>('SELECT *, e.* FROM events e');
        expect(select.columns[0].expression.kind).toBe('Star');
        expect((select.columns[1].expression as Star).qualifier?.name).toBe('e');
    });

    it('parses SELECT * EXCEPT', () => {
        const select = first<SelectStatement>('SELECT * EXCEPT (a, b) FROM t');
        expect((select.columns[0].expression as Star).except?.map(e => e.name)).toEqual(['a', 'b']);
    });

    it('parses subqueries in expressions', () => {
        expect(parseExpressionText('(SELECT 1)')).toMatchObject({ kind: 'SubqueryExpression' });
    });

    it('parses query parameters', () => {
        expect(parseExpressionText('{id:UInt64}')).toMatchObject({ kind: 'Placeholder' });
    });
});

describe('DDL', () => {
    it('parses CREATE TABLE', () => {
        const create = first<CreateTableStatement>(
            "CREATE TABLE IF NOT EXISTS db.t (a UInt64, b Nullable(String) DEFAULT '' CODEC(ZSTD) COMMENT 'note') " +
                'ENGINE = MergeTree PARTITION BY toYYYYMM(d) ORDER BY (a, b) TTL d + INTERVAL 30 DAY ' +
                'SETTINGS index_granularity = 8192'
        );
        expect(create.ifNotExists).toBe(true);
        expect(create.table?.database?.name).toBe('db');
        expect(create.columns).toHaveLength(2);
        expect(create.columns[1]).toMatchObject({
            typeText: 'Nullable(String)',
            defaultKind: 'DEFAULT',
            codec: '(ZSTD)',
            comment: 'note',
        });
        expect(create.engine).toBe('MergeTree');
        // `ORDER BY (a, b)` is a single tuple key, not two keys.
        expect(create.orderBy).toHaveLength(1);
        expect(create.orderBy[0]).toMatchObject({ kind: 'Tuple' });
        expect(create.partitionBy).toHaveLength(1);
        expect(create.ttl).toBeDefined();
        expect(create.settings[0].name.name).toBe('index_granularity');
    });

    it('treats an unparenthesised ORDER BY as several keys', () => {
        const create = first<CreateTableStatement>('CREATE TABLE t (a UInt8) ENGINE = MergeTree ORDER BY a, b');
        expect(create.orderBy).toHaveLength(2);
    });

    it('parses CREATE TABLE ... AS SELECT', () => {
        const create = first<CreateTableStatement>('CREATE TABLE t ENGINE = Memory AS SELECT a FROM u');
        expect(create.select?.columns).toHaveLength(1);
    });

    it('skips index and projection declarations', () => {
        const create = first<CreateTableStatement>(
            'CREATE TABLE t (a UInt64, INDEX idx a TYPE minmax GRANULARITY 1, b String) ENGINE = MergeTree ORDER BY a'
        );
        expect(create.columns.map(c => c.name.name)).toEqual(['a', 'b']);
    });

    it('parses CREATE MATERIALIZED VIEW', () => {
        const view = first<import('../parser/ast').CreateViewStatement>(
            'CREATE MATERIALIZED VIEW mv TO dest AS SELECT a FROM src'
        );
        expect(view.materialized).toBe(true);
        expect(view.to?.table.name).toBe('dest');
        expect(view.select?.from?.source).toMatchObject({ table: { name: 'src' } });
    });

    it('parses INSERT ... VALUES', () => {
        const insert = first<InsertStatement>("INSERT INTO t (a, b) VALUES (1, 'x'), (2, 'y')");
        expect(insert.table?.table.name).toBe('t');
        expect(insert.columns.map(c => c.name)).toEqual(['a', 'b']);
        expect(insert.valuesCount).toBe(2);
    });

    it('parses INSERT ... SELECT', () => {
        const insert = first<InsertStatement>('INSERT INTO t SELECT a FROM u');
        expect(insert.select?.from?.source).toMatchObject({ table: { name: 'u' } });
    });

    it('parses ALTER TABLE', () => {
        const alter = first<import('../parser/ast').AlterTableStatement>(
            'ALTER TABLE t ADD COLUMN c UInt8, DROP COLUMN d'
        );
        expect(alter.table?.table.name).toBe('t');
        expect(alter.actions).toEqual(['ADD COLUMN c UInt8', 'DROP COLUMN d']);
    });

    it('parses ALTER TABLE ... UPDATE ... WHERE', () => {
        const alter = first<import('../parser/ast').AlterTableStatement>(
            'ALTER TABLE t UPDATE x = 1 WHERE y = 2'
        );
        expect(alter.where).toBeDefined();
    });

    it('parses DROP', () => {
        const drop = first<import('../parser/ast').DropStatement>('DROP TABLE IF EXISTS db.t');
        expect(drop).toMatchObject({ what: 'DROP TABLE', ifExists: true });
        expect(drop.target?.table.name).toBe('t');
    });

    it('records unmodelled statements', () => {
        expect(first<import('../parser/ast').OtherStatement>('SYSTEM RELOAD DICTIONARIES')).toMatchObject({
            kind: 'OtherStatement',
        });
    });
});

describe('error tolerance', () => {
    it('still finds the FROM after a trailing comma', () => {
        const select = first<SelectStatement>('SELECT a, FROM t WHERE');
        expect(select.columns).toHaveLength(1);
        expect(select.from?.source).toMatchObject({ table: { name: 't' } });
        expect(diagnostics('SELECT a, FROM t WHERE')).toContain('Trailing comma before the next clause');
    });

    it('reports a missing expression but keeps the tree', () => {
        const select = first<SelectStatement>('SELECT a FROM t WHERE x = 1 AND ');
        expect(select.where).toBeDefined();
        expect(select.from?.source).toMatchObject({ table: { name: 't' } });
    });

    it('reports a missing table', () => {
        expect(diagnostics('SELECT a FROM ')).toContain('Expected a table name');
    });

    it('reports a join without a condition', () => {
        expect(diagnostics('SELECT a FROM t JOIN u').join(' ')).toContain('requires ON or USING');
        expect(diagnostics('SELECT a FROM t CROSS JOIN u')).toEqual([]);
    });

    it('reports an unclosed CASE', () => {
        expect(diagnostics('SELECT CASE WHEN a THEN 1 FROM t').join(' ')).toContain('END');
    });

    it('never throws and always terminates', () => {
        const inputs = [
            '', '   ', ';', ';;;', 'SELECT', 'SELECT FROM', 'FROM', ')', '(', '((((',
            'SELECT ((((', "SELECT 'unterminated", 'SELECT /* unterminated', 'SELECT `unterminated',
            'SELECT a FROM t WHERE (', 'SELECT a, , b FROM t', 'WITH', 'WITH x AS', 'WITH x AS (',
            'CREATE TABLE', 'CREATE TABLE t (', 'INSERT INTO', 'ALTER TABLE', 'DROP',
            'SELECT * FROM t GROUP BY', 'SELECT * FROM t ORDER BY', ']]][[[',
            'SELECT a -> -> b', 'SELECT ...', '@@@@', 'SELECT 1 SELECT 2',
        ];
        for (const input of inputs) {
            expect(() => parse(input)).not.toThrow();
        }
    });

    it('survives random token soup', () => {
        const pieces = ['SELECT', 'FROM', '(', ')', ',', 'a', '1', "'s'", 'JOIN', 'ON', '=', '*', ';', 'WHERE', 'AS'];
        let seed = 12345;
        const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
        for (let n = 0; n < 300; n++) {
            const length = 1 + Math.floor(random() * 20);
            const sql = Array.from({ length }, () => pieces[Math.floor(random() * pieces.length)]).join(' ');
            expect(() => parse(sql)).not.toThrow();
        }
    });

    it('covers the whole input with statement offsets', () => {
        const sql = 'SELECT a FROM t; SELECT b FROM u';
        const program = parse(sql).program;
        for (const statement of program.statements) {
            expect(statement.start).toBeGreaterThanOrEqual(0);
            expect(statement.end).toBeGreaterThan(statement.start);
            expect(statement.end).toBeLessThanOrEqual(sql.length);
        }
    });
});
