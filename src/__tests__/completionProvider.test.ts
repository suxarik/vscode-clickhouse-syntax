/**
 * Tests for completion.
 */
import * as vscode from 'vscode';
import { buildCompletions, resolveCompletion } from '../providers/completionProvider';
import { getSqlContextFromText, isAfterDot } from '../sqlContext';
import { SchemaManager } from '../schemaManager';
import { Catalog } from '../catalog';
import { makeSchemaManager, makeConfig, makeCatalog, docAt } from './helpers';
import { AnalysisCache } from '../analysis';
import { scopeAt, visibleCtes, visibleTables } from '../parser/binder';

let schemaManager: SchemaManager;
let catalog: Catalog;
let analysisCache: AnalysisCache;

beforeAll(async () => {
    schemaManager = await makeSchemaManager();
    catalog = makeCatalog();
    await catalog.systemTables();
    analysisCache = new AnalysisCache(schemaManager, catalog);
});

/** Completion items offered at the `|` marker. */
async function itemsAt(sql: string, overrides: Record<string, unknown> = {}): Promise<vscode.CompletionItem[]> {
    const { document, offset, position } = docAt(sql);
    const context = getSqlContextFromText(document.getText(), offset);
    const dot = isAfterDot(document, position);
    const scope = scopeAt(analysisCache.get(document).binding, offset);
    return buildCompletions(
        context,
        dot,
        schemaManager,
        catalog,
        makeConfig(overrides),
        visibleTables(scope),
        visibleCtes(scope).map(cte => cte.name.name)
    );
}

async function labelsAt(sql: string, overrides: Record<string, unknown> = {}): Promise<string[]> {
    const items = await itemsAt(sql, overrides);
    return items.map(item => (typeof item.label === 'string' ? item.label : item.label.label));
}

describe('clause awareness', () => {
    it('offers columns in a WHERE that follows an AND', async () => {
        // The clause-detection regression made this return no columns at all.
        const labels = await labelsAt('SELECT a FROM events WHERE x = 1 AND |');
        expect(labels).toContain('event_id');
        expect(labels).toContain('user_id');
    });

    it('offers columns in ORDER BY after an AND-filtered WHERE', async () => {
        expect(await labelsAt('SELECT a FROM events WHERE x = 1 AND y = 2 ORDER BY |')).toContain('event_time');
    });

    it('offers tables in FROM', async () => {
        const labels = await labelsAt('SELECT a FROM |');
        expect(labels).toContain('events');
        expect(labels).toContain('users');
        expect(labels).toContain('analytics.events');
    });

    it('offers only the scoped table columns', async () => {
        const labels = await labelsAt('SELECT | FROM users');
        expect(labels).toContain('name');
        expect(labels).not.toContain('event_time');
    });

    it('offers nothing inside a string literal', async () => {
        expect(await labelsAt("SELECT 'abc|' FROM events")).toEqual([]);
    });

    it('offers nothing inside a comment', async () => {
        expect(await labelsAt('-- note |\nSELECT 1')).toEqual([]);
    });
});

describe('qualified prefixes', () => {
    it('resolves an alias qualifier', async () => {
        const labels = await labelsAt('SELECT e.| FROM analytics.events AS e');
        expect(labels).toEqual(expect.arrayContaining(['event_id', 'event_time', 'user_id']));
        expect(labels).not.toContain('name');
    });

    it('resolves a table qualifier', async () => {
        expect(await labelsAt('SELECT users.| FROM users')).toContain('name');
    });

    it('resolves a database qualifier to its tables', async () => {
        expect(await labelsAt('SELECT a FROM analytics.|')).toEqual(expect.arrayContaining(['events', 'users']));
    });

    it('qualifies columns when several tables are in scope', async () => {
        const labels = await labelsAt('SELECT | FROM events e JOIN users u ON e.user_id = u.user_id');
        expect(labels).toContain('e.event_id');
        expect(labels).toContain('u.name');
    });

    it('offers CTE names as tables', async () => {
        expect(await labelsAt('WITH recent AS (SELECT 1) SELECT * FROM |')).toContain('recent');
    });

    it('offers the columns a CTE projects', async () => {
        const labels = await labelsAt(
            'WITH recent AS (SELECT event_id, count() AS n FROM events) SELECT | FROM recent'
        );
        expect(labels).toContain('event_id');
        expect(labels).toContain('n');
        // `name` belongs to users, which is not in scope here.
        expect(labels).not.toContain('name');
    });

    it('offers the columns a subquery projects', async () => {
        const labels = await labelsAt('SELECT | FROM (SELECT user_id AS uid FROM users) s');
        expect(labels).toContain('uid');
    });

    it('resolves a qualifier onto a CTE', async () => {
        const labels = await labelsAt('WITH c AS (SELECT event_id FROM events) SELECT c.| FROM c');
        expect(labels).toEqual(['event_id']);
    });

    it('does not leak the outer query into a FROM subquery', async () => {
        const labels = await labelsAt('SELECT a FROM (SELECT | FROM users) s');
        expect(labels).toContain('name');
        expect(labels).not.toContain('event_time');
    });
});

describe('catalog-backed lists', () => {
    it('offers settings inside a SETTINGS clause and nothing else', async () => {
        const labels = await labelsAt('SELECT a FROM events SETTINGS |');
        expect(labels).toContain('max_threads');
        expect(labels).toContain('max_execution_time');
        expect(labels).not.toContain('SELECT');
        expect(labels).not.toContain('count');
    });

    it('offers formats after FORMAT', async () => {
        const labels = await labelsAt('SELECT a FROM events FORMAT |');
        expect(labels).toContain('JSONEachRow');
        expect(labels).toContain('Parquet');
        expect(labels).not.toContain('count');
    });

    it('offers table engines after ENGINE =', async () => {
        const labels = await labelsAt('CREATE TABLE t (a UInt8) ENGINE = |');
        expect(labels).toContain('MergeTree');
        expect(labels).toContain('ReplacingMergeTree');
    });

    it('offers the system database in FROM', async () => {
        expect(await labelsAt('SELECT a FROM |')).toContain('system');
    });

    it('offers system tables after `system.`', async () => {
        const labels = await labelsAt('SELECT a FROM system.|');
        expect(labels).toContain('query_log');
        expect(labels).toContain('parts');
        expect(labels).toContain('columns');
    });

    it('offers system table columns when one is in scope', async () => {
        const labels = await labelsAt('SELECT | FROM system.parts');
        expect(labels).toContain('database');
        expect(labels).toContain('table');
        expect(labels).toContain('active');
    });

    it('offers the full function catalog, not just the curated set', async () => {
        const labels = await labelsAt('SELECT | FROM events');
        expect(labels).toContain('count');
        expect(labels).toContain('arrayMap');
        // Present in the generated catalog but never in the hand-written table.
        expect(labels).toContain('toStartOfFifteenMinutes');
        expect(labels.length).toBeGreaterThan(1500);
    });

    it('offers data types from the catalog', async () => {
        const labels = await labelsAt('CREATE TABLE t (a |)');
        expect(labels).toContain('UInt64');
        expect(labels).toContain('LowCardinality');
    });
});

describe('version gating', () => {
    it('hides functions newer than the configured server version', async () => {
        const recent = catalog.functions().find(fn => fn.since && fn.since.startsWith('25'));
        expect(recent).toBeDefined();

        const modern = await labelsAt('SELECT | FROM events');
        expect(modern).toContain(recent!.name);

        const old = await labelsAt('SELECT | FROM events', { serverVersion: '23.3' });
        expect(old).not.toContain(recent!.name);
        expect(old).toContain('count');
    });

    it('offers everything on auto', async () => {
        const auto = await labelsAt('SELECT | FROM events', { serverVersion: 'auto' });
        const unset = await labelsAt('SELECT | FROM events');
        expect(auto.length).toBe(unset.length);
    });
});

describe('ranking and toggles', () => {
    it('ranks scoped columns above functions', async () => {
        const items = await itemsAt('SELECT | FROM users');
        const column = items.find(i => i.label === 'name');
        const fn = items.find(i => i.label === 'count');
        expect(column!.sortText! < fn!.sortText!).toBe(true);
    });

    it('honours the feature toggles', async () => {
        expect(await labelsAt('SELECT | FROM users', { 'completion.includeFunctions': false })).not.toContain('count');
        expect(await labelsAt('SELECT | FROM users', { 'completion.includeKeywords': false })).not.toContain('SELECT');
        expect(await labelsAt('SELECT | FROM users', { 'completion.includeColumns': false })).not.toContain('name');
        expect(await labelsAt('SELECT a FROM |', { 'completion.includeTables': false })).not.toContain('users');
    });

    it('caps the list when maxItems is set', async () => {
        expect(await labelsAt('SELECT | FROM users', { 'completion.maxItems': 5 })).toHaveLength(5);
    });

    it('falls back to every column when no table resolves', async () => {
        const labels = await labelsAt('SELECT | FROM numbers(10)');
        expect(labels).toContain('event_id');
        expect(labels).toContain('name');
    });
});

describe('resolveCompletion', () => {
    it('fills in function documentation on demand', async () => {
        const items = await itemsAt('SELECT | FROM events');
        const item = items.find(i => i.label === 'arrayMap')!;
        expect(item.documentation).toBeUndefined();

        const resolved = await resolveCompletion(item, catalog);
        const md = resolved.documentation as vscode.MarkdownString;
        expect(md.value).toContain('lambda');
        expect(md.value).toContain('arrayMap(func, arr1, ...)');
    });

    it('fills in setting documentation on demand', async () => {
        const items = await itemsAt('SELECT a FROM events SETTINGS |');
        const item = items.find(i => i.label === 'max_threads')!;
        const resolved = await resolveCompletion(item, catalog);
        expect((resolved.documentation as vscode.MarkdownString).value.length).toBeGreaterThan(10);
    });

    it('leaves an already-documented item alone', async () => {
        const items = await itemsAt('SELECT | FROM users');
        const column = items.find(i => i.label === 'name')!;
        const before = column.documentation;
        expect(await resolveCompletion(column, catalog)).toBe(column);
        expect(column.documentation).toBe(before);
    });
});
