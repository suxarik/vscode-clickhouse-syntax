/**
 * Tests for the lint rules and the rule engine.
 */
import { analyzeText, makeColumnSource } from '../analysis';
import { lint, RULES, RULES_BY_ID } from '../lint/engine';
import { SchemaManager } from '../schemaManager';
import { Catalog } from '../catalog';
import { makeSchemaManager, makeCatalog } from './helpers';

let schemaManager: SchemaManager;
let catalog: Catalog;

beforeAll(async () => {
    schemaManager = await makeSchemaManager();
    catalog = makeCatalog();
    // The system-table asset is read lazily; several rules need it loaded.
    await catalog.systemTables();
});

function findings(sql: string, options: Parameters<typeof lint>[3] = {}) {
    const analysis = { version: 1, ...analyzeText(sql, makeColumnSource(schemaManager, catalog)) };
    return lint(analysis, schemaManager, catalog, options);
}

function ids(sql: string, options: Parameters<typeof lint>[3] = {}): string[] {
    return findings(sql, options).map(f => f.ruleId);
}

describe('rule registry', () => {
    it('gives every rule an id, a description and a severity', () => {
        for (const rule of RULES) {
            expect(rule.id).toMatch(/^[a-z][a-z0-9-]*$/);
            expect(rule.description.length).toBeGreaterThan(10);
            expect(['off', 'hint', 'info', 'warning', 'error']).toContain(rule.defaultSeverity);
        }
    });

    it('has no duplicate ids', () => {
        expect(RULES_BY_ID.size).toBe(RULES.length);
    });
});

describe('syntax-error', () => {
    it('reports a parse failure', () => {
        expect(ids('SELECT a FROM')).toContain('syntax-error');
    });

    it('stays quiet on a valid query', () => {
        expect(ids('SELECT event_id FROM events')).not.toContain('syntax-error');
    });
});

describe('unknown-table', () => {
    it('flags a table not in the schema', () => {
        expect(ids('SELECT a FROM ghosts')).toContain('unknown-table');
    });

    it('accepts a known table, qualified or not', () => {
        expect(ids('SELECT event_id FROM events')).not.toContain('unknown-table');
        expect(ids('SELECT event_id FROM analytics.events')).not.toContain('unknown-table');
    });

    it('accepts a CTE', () => {
        expect(ids('WITH c AS (SELECT 1 AS x) SELECT x FROM c')).not.toContain('unknown-table');
    });

    it('accepts a system table', () => {
        expect(ids('SELECT database FROM system.parts')).not.toContain('unknown-table');
    });

    it('flags a name that is not a system table', () => {
        expect(ids('SELECT a FROM system.not_a_table')).toContain('unknown-table');
    });

    it('ignores table functions', () => {
        expect(ids('SELECT a FROM numbers(10)')).not.toContain('unknown-table');
    });
});

describe('unknown-column', () => {
    it('flags a column no table in scope has', () => {
        expect(ids('SELECT nonsense FROM events')).toContain('unknown-column');
    });

    it('accepts a real column', () => {
        expect(ids('SELECT event_id FROM events')).not.toContain('unknown-column');
    });

    it('stays quiet when a table is unknown', () => {
        expect(ids('SELECT anything FROM ghosts')).not.toContain('unknown-column');
    });

    it('resolves through an alias', () => {
        expect(ids('SELECT e.event_id FROM events e')).not.toContain('unknown-column');
        expect(ids('SELECT e.name FROM events e')).toContain('unknown-column');
    });

    it('flags an unknown qualifier', () => {
        expect(ids('SELECT zzz.event_id FROM events e')).toContain('unknown-column');
    });

    it('accepts a lambda parameter', () => {
        expect(ids('SELECT arrayMap(x -> x + 1, tags) FROM events')).not.toContain('unknown-column');
    });

    it('accepts an ARRAY JOIN alias', () => {
        expect(ids('SELECT tag FROM events ARRAY JOIN tags AS tag')).not.toContain('unknown-column');
    });

    it('accepts a select-list alias used later', () => {
        expect(ids('SELECT event_id AS eid FROM events ORDER BY eid')).not.toContain('unknown-column');
    });

    it('accepts a CTE projection column', () => {
        expect(ids('WITH c AS (SELECT event_id FROM events) SELECT event_id FROM c')).not.toContain('unknown-column');
    });

    it('flags a column a CTE does not project', () => {
        expect(ids('WITH c AS (SELECT event_id FROM events) SELECT user_id FROM c')).toContain('unknown-column');
    });

    it('accepts system table columns', () => {
        expect(ids('SELECT query_duration_ms FROM system.query_log')).not.toContain('unknown-column');
    });
});

describe('ambiguous-column', () => {
    it('flags a column both joined tables have', () => {
        expect(ids('SELECT user_id FROM events JOIN users ON 1 = 1')).toContain('ambiguous-column');
    });

    it('accepts it once qualified', () => {
        expect(ids('SELECT events.user_id FROM events JOIN users ON 1 = 1')).not.toContain('ambiguous-column');
    });

    it('accepts a column unique to one table', () => {
        expect(ids('SELECT name FROM events JOIN users ON 1 = 1')).not.toContain('ambiguous-column');
    });
});

describe('unknown-function', () => {
    it('flags a function ClickHouse does not have', () => {
        expect(ids('SELECT definitely_not_a_function(1)')).toContain('unknown-function');
    });

    it('accepts real functions', () => {
        expect(ids('SELECT count(), arrayMap(x -> x, [1])')).not.toContain('unknown-function');
    });

    it('flags a function newer than the configured server', () => {
        const recent = catalog.functions().find(fn => fn.since?.startsWith('25'))!;
        expect(ids(`SELECT ${recent.name}()`, { serverVersion: '23.3' })).toContain('unknown-function');
        expect(ids(`SELECT ${recent.name}()`)).not.toContain('unknown-function');
    });
});

describe('aggregate-in-filter', () => {
    it('flags an aggregate in WHERE', () => {
        expect(ids('SELECT user_id FROM events WHERE count() > 1')).toContain('aggregate-in-filter');
    });

    it('flags an aggregate combinator in WHERE', () => {
        expect(ids('SELECT user_id FROM events WHERE countIf(event_id > 1) > 1')).toContain('aggregate-in-filter');
    });

    it('accepts an aggregate in HAVING', () => {
        expect(ids('SELECT user_id FROM events GROUP BY user_id HAVING count() > 1')).not.toContain(
            'aggregate-in-filter'
        );
    });

    it('accepts an aggregate inside a subquery in WHERE', () => {
        expect(
            ids('SELECT user_id FROM events WHERE user_id IN (SELECT user_id FROM users GROUP BY user_id HAVING count() > 1)')
        ).not.toContain('aggregate-in-filter');
    });
});

describe('engine-aware rules', () => {
    it('flags a deduplicating table read without FINAL', () => {
        expect(ids('SELECT user_id FROM users')).toContain('missing-final');
        expect(ids('SELECT user_id FROM users FINAL')).not.toContain('missing-final');
    });

    it('flags FINAL on a plain MergeTree', () => {
        expect(ids('SELECT event_id FROM events FINAL')).toContain('final-on-plain-mergetree');
        expect(ids('SELECT event_id FROM events')).not.toContain('final-on-plain-mergetree');
    });

    it('does not flag PREWHERE on a MergeTree table', () => {
        expect(ids('SELECT event_id FROM events PREWHERE event_id > 1')).not.toContain('prewhere-on-non-mergetree');
    });
});

describe('practice rules', () => {
    it('flags SELECT *', () => {
        expect(ids('SELECT * FROM events')).toContain('select-star');
        expect(ids('SELECT e.* FROM events e')).not.toContain('select-star');
        expect(ids('SELECT * EXCEPT (tags) FROM events')).not.toContain('select-star');
    });

    it('flags NOT IN against a subquery only', () => {
        expect(ids('SELECT event_id FROM events WHERE user_id NOT IN (SELECT user_id FROM users)')).toContain(
            'inefficient-not-in'
        );
        expect(ids('SELECT event_id FROM events WHERE user_id NOT IN (1, 2)')).not.toContain('inefficient-not-in');
    });

    it('flags LIMIT without ORDER BY', () => {
        expect(ids('SELECT event_id FROM events LIMIT 10')).toContain('unbounded-limit');
        expect(ids('SELECT event_id FROM events ORDER BY event_id LIMIT 10')).not.toContain('unbounded-limit');
    });

    it('judges LIMIT per statement', () => {
        const result = ids(
            'SELECT event_id FROM events ORDER BY event_id LIMIT 1; SELECT event_id FROM events LIMIT 1'
        );
        expect(result.filter(id => id === 'unbounded-limit')).toHaveLength(1);
    });

    it('flags a top-level OR in a filter', () => {
        expect(ids('SELECT event_id FROM events WHERE user_id = 1 OR event_id = 2')).toContain(
            'or-index-inefficiency'
        );
        expect(ids('SELECT event_id FROM events WHERE user_id = 1 AND event_id = 2')).not.toContain(
            'or-index-inefficiency'
        );
    });

    it('flags a cross join', () => {
        expect(ids('SELECT event_id FROM events, users')).toContain('cross-join');
        expect(ids('SELECT event_id FROM events JOIN users ON 1 = 1')).not.toContain('cross-join');
    });
});

describe('settings rules', () => {
    it('flags an unknown setting', () => {
        expect(ids('SELECT event_id FROM events SETTINGS not_a_real_setting = 1')).toContain('unknown-setting');
    });

    it('accepts a real setting', () => {
        expect(ids('SELECT event_id FROM events SETTINGS max_threads = 8')).not.toContain('unknown-setting');
    });

    it('accepts MergeTree settings in DDL', () => {
        expect(
            ids('CREATE TABLE t (a UInt8) ENGINE = MergeTree ORDER BY a SETTINGS index_granularity = 8192')
        ).not.toContain('unknown-setting');
    });

    it('flags an impossible value type', () => {
        expect(ids("SELECT event_id FROM events SETTINGS max_threads = 'lots'")).toContain('setting-type-mismatch');
        expect(ids("SELECT event_id FROM events SETTINGS max_memory_usage = '10G'")).not.toContain(
            'setting-type-mismatch'
        );
    });

    it('notes a non-production setting', () => {
        const experimental = catalog.settings().find(s => s.tier && !s.mergeTree)!;
        expect(ids(`SELECT event_id FROM events SETTINGS ${experimental.name} = 1`)).toContain(
            'experimental-setting'
        );
    });
});

describe('severity configuration', () => {
    it('uses each rule\'s default severity', () => {
        const found = findings('SELECT * FROM events');
        expect(found.find(f => f.ruleId === 'select-star')?.severity).toBe('info');
    });

    it('honours an override', () => {
        const found = findings('SELECT * FROM events', { severities: { 'select-star': 'error' } });
        expect(found.find(f => f.ruleId === 'select-star')?.severity).toBe('error');
    });

    it('silences a rule set to off', () => {
        expect(ids('SELECT * FROM events', { severities: { 'select-star': 'off' } })).not.toContain('select-star');
    });

    it('ignores an unrecognised severity', () => {
        const found = findings('SELECT * FROM events', { severities: { 'select-star': 'nonsense' } });
        expect(found.find(f => f.ruleId === 'select-star')?.severity).toBe('info');
    });
});

describe('inline disables', () => {
    it('silences the next line for one rule', () => {
        const sql = '-- ch-lint-disable-next-line select-star\nSELECT * FROM events';
        expect(ids(sql)).not.toContain('select-star');
    });

    it('silences only the named rule', () => {
        const sql = '-- ch-lint-disable-next-line unknown-table\nSELECT * FROM events';
        expect(ids(sql)).toContain('select-star');
    });

    it('silences everything when no rule is named', () => {
        const sql = '-- ch-lint-disable-next-line\nSELECT * FROM ghosts';
        expect(ids(sql)).toEqual([]);
    });

    it('silences the line it sits on', () => {
        expect(ids('SELECT * FROM events -- ch-lint-disable-line select-star')).not.toContain('select-star');
    });

    it('silences a region until enabled again', () => {
        const sql = [
            '-- ch-lint-disable select-star',
            'SELECT * FROM events;',
            '-- ch-lint-enable select-star',
            'SELECT * FROM events;',
        ].join('\n');
        expect(ids(sql).filter(id => id === 'select-star')).toHaveLength(1);
    });

    it('silences to the end of the file when never enabled', () => {
        const sql = ['-- ch-lint-disable select-star', 'SELECT * FROM events;', 'SELECT * FROM events;'].join('\n');
        expect(ids(sql)).not.toContain('select-star');
    });

    it('accepts several rules in one directive', () => {
        const sql = '-- ch-lint-disable-next-line select-star, unknown-table\nSELECT * FROM ghosts';
        expect(ids(sql)).toEqual([]);
    });

    it('works in a block comment', () => {
        expect(ids('/* ch-lint-disable-next-line select-star */\nSELECT * FROM events')).not.toContain('select-star');
    });
});

describe('robustness', () => {
    it('produces no findings for empty input', () => {
        expect(ids('')).toEqual([]);
    });

    it('never throws on malformed input', () => {
        for (const sql of ['((((', 'SELECT', ';;;', 'SELECT a FROM t WHERE (', '@@@']) {
            expect(() => ids(sql)).not.toThrow();
        }
    });
});
