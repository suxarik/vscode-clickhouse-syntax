/**
 * Tests for scope analysis.
 */
import { parse } from '../parser/parser';
import {
    bind,
    ColumnSource,
    projectionOf,
    resolveName,
    scopeAt,
    visibleCtes,
    visibleTables,
} from '../parser/binder';
import { SelectStatement } from '../parser/ast';

/** Schema stand-in for the binder. */
const COLUMNS: Record<string, string[]> = {
    events: ['event_id', 'event_time', 'user_id', 'tags'],
    users: ['user_id', 'name'],
};

const source: ColumnSource = {
    columnsOf: (table: string) => COLUMNS[table.toLowerCase()],
};

function analyse(sql: string) {
    return bind(parse(sql).program, source);
}

/** Bind a query with a `|` cursor marker and return the scope there. */
function scopeMarked(sql: string) {
    const offset = sql.indexOf('|');
    const result = analyse(sql.replace('|', ''));
    return { result, scope: scopeAt(result, offset) };
}

describe('table binding', () => {
    it('binds tables with their columns', () => {
        const scope = analyse('SELECT a FROM events').scopes[0];
        expect(scope.tables).toHaveLength(1);
        expect(scope.tables[0]).toMatchObject({ label: 'events', kind: 'table' });
        expect(scope.tables[0].columns).toEqual(COLUMNS.events);
    });

    it('labels a table by its alias', () => {
        const scope = analyse('SELECT a FROM events AS e').scopes[0];
        expect(scope.tables[0]).toMatchObject({ label: 'e', alias: 'e', table: 'events' });
    });

    it('binds joined tables', () => {
        const scope = analyse('SELECT a FROM events e JOIN users u ON e.user_id = u.user_id').scopes[0];
        expect(scope.tables.map(t => t.label)).toEqual(['e', 'u']);
    });

    it('leaves an unknown table without columns', () => {
        const scope = analyse('SELECT a FROM ghosts').scopes[0];
        expect(scope.tables[0].columns).toBeUndefined();
    });

    it('records FINAL', () => {
        expect(analyse('SELECT a FROM events FINAL').scopes[0].tables[0].final).toBe(true);
    });

    it('binds a table function without columns', () => {
        const scope = analyse('SELECT a FROM numbers(10) AS n').scopes[0];
        expect(scope.tables[0]).toMatchObject({ kind: 'tableFunction', label: 'n' });
    });
});

describe('CTEs and subqueries', () => {
    it('binds a CTE and its projection', () => {
        const result = analyse('WITH recent AS (SELECT user_id, name FROM users) SELECT * FROM recent');
        const outer = result.scopes[0];
        expect(outer.ctes.has('recent')).toBe(true);
        const bound = outer.tables[0];
        expect(bound.kind).toBe('cte');
        expect(bound.columns).toEqual(['user_id', 'name']);
    });

    it('uses the alias of a CTE projection column', () => {
        const result = analyse('WITH c AS (SELECT count() AS n FROM users) SELECT * FROM c');
        expect(result.scopes[0].tables[0].columns).toEqual(['n']);
    });

    it('cannot name the projection through a star', () => {
        const result = analyse('WITH c AS (SELECT * FROM users) SELECT * FROM c');
        expect(result.scopes[0].tables[0].columns).toBeUndefined();
    });

    it('binds a subquery source', () => {
        const result = analyse('SELECT a FROM (SELECT user_id FROM users) AS s');
        expect(result.scopes[0].tables[0]).toMatchObject({ kind: 'subquery', label: 's', columns: ['user_id'] });
    });

    it('gives a subquery its own scope', () => {
        const result = analyse('SELECT a FROM (SELECT user_id FROM users) AS s');
        expect(result.scopes).toHaveLength(2);
        expect(result.scopes[1].tables[0].label).toBe('users');
    });

    it('makes CTEs visible to later CTEs', () => {
        const result = analyse('WITH a AS (SELECT 1), b AS (SELECT * FROM a) SELECT * FROM b');
        const inner = result.scopes.find(s => s.select?.from?.source?.kind === 'TableRef' && s !== result.scopes[0]);
        expect(visibleCtes(inner).map(c => c.name.name)).toContain('a');
    });
});

describe('scopeAt', () => {
    it('finds the innermost subquery scope', () => {
        const { scope } = scopeMarked('SELECT a FROM outer_t WHERE id IN (SELECT | FROM users)');
        expect(scope?.tables.map(t => t.label)).toEqual(['users']);
    });

    it('falls back to the last open scope for a cursor past the end', () => {
        const { scope } = scopeMarked('SELECT a FROM events WHERE |');
        expect(scope?.tables.map(t => t.label)).toEqual(['events']);
    });

    it('finds the outer scope outside a subquery', () => {
        const { scope } = scopeMarked('SELECT | FROM outer_t WHERE id IN (SELECT x FROM users)');
        expect(scope?.tables.map(t => t.label)).toEqual(['outer_t']);
    });

    it('finds a lambda scope', () => {
        const { scope } = scopeMarked('SELECT arrayMap(x -> x| * 2, tags) FROM events');
        expect(scope?.kind).toBe('lambda');
        expect(scope?.lambdaParams.has('x')).toBe(true);
    });
});

describe('scope isolation', () => {
    it('hides the outer query from a FROM subquery', () => {
        const { scope } = scopeMarked('SELECT | FROM events');
        expect(scope?.isolated).toBe(false);

        const { scope: inner } = scopeMarked('SELECT a FROM (SELECT | FROM users) s');
        expect(inner?.isolated).toBe(true);
        expect(visibleTables(inner).map(t => t.label)).toEqual(['users']);
    });

    it('hides the main query from a CTE body', () => {
        const { scope } = scopeMarked('WITH c AS (SELECT | FROM users) SELECT * FROM events');
        expect(visibleTables(scope).map(t => t.label)).toEqual(['users']);
    });

    it('keeps a correlated subquery in WHERE connected to the outer query', () => {
        const { scope } = scopeMarked('SELECT a FROM events WHERE user_id IN (SELECT | FROM users)');
        expect(visibleTables(scope).map(t => t.label)).toEqual(['users', 'events']);
    });

    it('does not let a subquery see its own alias', () => {
        const { scope } = scopeMarked('SELECT a FROM (SELECT | FROM users) AS s');
        expect(visibleTables(scope).map(t => t.label)).not.toContain('s');
    });

    it('still resolves CTEs declared outside an isolated scope', () => {
        const result = analyse('WITH a AS (SELECT 1 AS x), b AS (SELECT * FROM a) SELECT * FROM b');
        const inner = result.scopes.find(s => s.isolated && s.tables.some(t => t.label === 'a'));
        expect(inner).toBeDefined();
        expect(visibleCtes(inner).map(c => c.name.name)).toContain('a');
    });
});

describe('visibleTables', () => {
    it('includes the enclosing query from a correlated subquery', () => {
        const { scope } = scopeMarked('SELECT a FROM events WHERE id IN (SELECT | FROM users)');
        expect(visibleTables(scope).map(t => t.label)).toEqual(['users', 'events']);
    });

    it('includes the enclosing query from a lambda', () => {
        const { scope } = scopeMarked('SELECT arrayMap(x -> |x, tags) FROM events');
        expect(visibleTables(scope).map(t => t.label)).toEqual(['events']);
    });
});

describe('resolveName', () => {
    const resolve = (sql: string, name: string, qualifier?: string) => {
        const { scope } = scopeMarked(sql);
        return resolveName(scope, name, qualifier);
    };

    it('resolves a column of a table in scope', () => {
        expect(resolve('SELECT | FROM events', 'event_id')).toMatchObject({ kind: 'column' });
    });

    it('reports a column no table has', () => {
        expect(resolve('SELECT | FROM events', 'nonsense')).toMatchObject({ kind: 'unknown' });
    });

    it('stays indeterminate when a table is unknown', () => {
        expect(resolve('SELECT | FROM ghosts', 'anything')).toMatchObject({ kind: 'indeterminate' });
    });

    it('reports every table an ambiguous column belongs to', () => {
        const resolution = resolve('SELECT | FROM events JOIN users ON 1', 'user_id');
        expect(resolution.kind).toBe('column');
        expect(resolution.kind === 'column' && resolution.tables).toHaveLength(2);
    });

    it('resolves through an alias qualifier', () => {
        expect(resolve('SELECT | FROM events AS e', 'event_id', 'e')).toMatchObject({ kind: 'column' });
        expect(resolve('SELECT | FROM events AS e', 'name', 'e')).toMatchObject({ kind: 'unknown' });
    });

    it('reports an unknown qualifier', () => {
        expect(resolve('SELECT | FROM events AS e', 'x', 'zzz')).toMatchObject({ kind: 'unknownQualifier' });
    });

    it('resolves a lambda parameter', () => {
        expect(resolve('SELECT arrayMap(x -> |x, tags) FROM events', 'x')).toMatchObject({ kind: 'lambdaParam' });
    });

    it('resolves an ARRAY JOIN alias', () => {
        expect(resolve('SELECT | FROM events ARRAY JOIN tags AS tag', 'tag')).toMatchObject({ kind: 'arrayJoin' });
    });

    it('resolves a select-list alias', () => {
        expect(resolve('SELECT event_id AS eid, | FROM events', 'eid')).toMatchObject({ kind: 'alias' });
    });

    it('prefers a real column over a same-named alias', () => {
        expect(resolve('SELECT 1 AS event_id, | FROM events', 'event_id')).toMatchObject({ kind: 'column' });
    });
});

describe('references', () => {
    it('records column, table and function references', () => {
        const result = analyse('SELECT count(event_id) FROM events');
        const kinds = result.references.map(r => `${r.kind}:${r.name}`);
        expect(kinds).toContain('table:events');
        expect(kinds).toContain('function:count');
        expect(kinds).toContain('column:event_id');
    });

    it('records the qualifier of a dotted reference', () => {
        const result = analyse('SELECT e.event_id FROM events e');
        const column = result.references.find(r => r.kind === 'column');
        expect(column).toMatchObject({ name: 'event_id', qualifier: 'e' });
    });

    it('records the database of a qualified table', () => {
        const result = analyse('SELECT a FROM analytics.events');
        expect(result.references.find(r => r.kind === 'table')).toMatchObject({
            name: 'events',
            database: 'analytics',
        });
    });

    it('records settings', () => {
        const result = analyse('SELECT a FROM events SETTINGS max_threads = 4');
        expect(result.references.find(r => r.kind === 'setting')?.name).toBe('max_threads');
    });

    it('records a named window reference', () => {
        const result = analyse('SELECT sum(x) OVER w FROM events WINDOW w AS (ORDER BY event_time)');
        expect(result.references.find(r => r.kind === 'window')?.name).toBe('w');
    });
});

describe('projectionOf', () => {
    const select = (sql: string) => parse(sql).program.statements[0] as SelectStatement;

    it('names plain columns', () => {
        expect(projectionOf(select('SELECT a, b FROM t'))).toEqual(['a', 'b']);
    });

    it('prefers aliases', () => {
        expect(projectionOf(select('SELECT a AS x, count() AS n FROM t'))).toEqual(['x', 'n']);
    });

    it('takes the last part of a qualified name', () => {
        expect(projectionOf(select('SELECT t.a FROM t'))).toEqual(['a']);
    });

    it('gives up on a star', () => {
        expect(projectionOf(select('SELECT * FROM t'))).toBeUndefined();
    });

    it('gives up on an unaliased expression', () => {
        expect(projectionOf(select('SELECT count() FROM t'))).toBeUndefined();
    });
});

describe('DDL binding', () => {
    it('exposes the table being created for its keys', () => {
        const result = analyse('CREATE TABLE t (a UInt64, b String) ENGINE = MergeTree ORDER BY a');
        expect(result.scopes[0].tables[0].columns).toEqual(['a', 'b']);
        expect(resolveName(result.scopes[0], 'a')).toMatchObject({ kind: 'column' });
        expect(resolveName(result.scopes[0], 'zzz')).toMatchObject({ kind: 'unknown' });
    });

    it('binds the SELECT of a materialized view', () => {
        const result = analyse('CREATE MATERIALIZED VIEW mv TO dest AS SELECT user_id FROM users');
        expect(result.scopes.some(s => s.tables.some(t => t.label === 'users'))).toBe(true);
    });

    it('binds the filter of an ALTER ... UPDATE', () => {
        const result = analyse('ALTER TABLE events UPDATE user_id = 1 WHERE event_id = 2');
        expect(resolveName(result.scopes[0], 'event_id')).toMatchObject({ kind: 'column' });
    });
});
