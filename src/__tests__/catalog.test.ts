/**
 * Tests for the generated catalog and its access layer.
 */
import { compareVersions, isAvailableIn, functionDetail, CATALOG_COUNTS, CATALOG_VERSION } from '../catalog';
import { makeCatalog } from './helpers';

const catalog = makeCatalog();

describe('bundled tier', () => {
    it('carries the whole ClickHouse function set', () => {
        expect(catalog.functions().length).toBeGreaterThan(1500);
        expect(CATALOG_COUNTS.functions).toBe(catalog.functions().length);
    });

    it('records the ClickHouse version it came from', () => {
        expect(CATALOG_VERSION).toMatch(/^\d+\.\d+/);
    });

    it('looks functions up case-insensitively', () => {
        expect(catalog.functionByName('arrayMap')?.name).toBe('arrayMap');
        expect(catalog.functionByName('ARRAYMAP')?.name).toBe('arrayMap');
        expect(catalog.functionByName('definitely_not_a_function')).toBeUndefined();
    });

    it('marks aggregates and higher-order functions', () => {
        expect(catalog.functionByName('quantile')?.aggregate).toBe(true);
        expect(catalog.functionByName('arrayMap')?.higherOrder).toBe(true);
        expect(catalog.functionByName('toString')?.aggregate).toBeUndefined();
    });

    it('carries a snippet for every function', () => {
        for (const fn of catalog.functions()) {
            expect(fn.snippet).toContain(fn.name);
        }
    });

    it('groups functions for grammar scopes', () => {
        expect(catalog.functionByName('count')?.group).toBe('aggregate');
        expect(catalog.functionByName('arrayMap')?.group).toBe('array');
        expect(catalog.functionByName('toDateTime64')?.group).toBe('type');
        expect(catalog.functionByName('splitByChar')?.group).toBe('string');
    });

    it('knows data types, engines, formats and settings', () => {
        expect(catalog.dataTypeByName('LowCardinality')).toBeDefined();
        expect(catalog.engineByName('ReplacingMergeTree')).toBeDefined();
        expect(catalog.formatByName('JSONEachRow')?.output).toBe(true);
        expect(catalog.settingByName('max_threads')?.type).toBeTruthy();
    });

    it('separates MergeTree settings from query settings', () => {
        const settings = catalog.settings();
        expect(settings.some(s => s.mergeTree)).toBe(true);
        expect(settings.some(s => !s.mergeTree)).toBe(true);
        expect(catalog.settingByName('index_granularity')?.mergeTree).toBe(true);
    });

    it('records engine capabilities as ClickHouse reports them', () => {
        expect(catalog.engineByName('MergeTree')?.supports).toEqual(
            expect.arrayContaining(['sortOrder', 'ttl', 'skippingIndices', 'settings'])
        );
        expect(catalog.engineByName('Memory')?.supports ?? []).not.toContain('sortOrder');
    });
});

describe('lazily-read assets', () => {
    it('reads function documentation', async () => {
        const doc = await catalog.functionDoc('arrayMap');
        expect(doc?.description).toContain('array');
        expect(doc?.args?.map(a => a.name)).toContain('func');
    });

    it('reads setting documentation', async () => {
        expect(await catalog.settingDoc('max_threads')).toContain('threads');
    });

    it('reads the system database', async () => {
        const tables = await catalog.systemTables();
        expect(tables.length).toBeGreaterThan(50);
        const queryLog = await catalog.systemTable('query_log');
        expect(queryLog?.columns.map(c => c.name)).toContain('query_duration_ms');
    });

    it('returns undefined for things it has no docs for', async () => {
        expect(await catalog.functionDoc('definitely_not_a_function')).toBeUndefined();
        expect(await catalog.systemTable('definitely_not_a_table')).toBeUndefined();
    });
});

describe('compareVersions', () => {
    it('orders versions', () => {
        expect(compareVersions('24.8', '23.3')).toBeGreaterThan(0);
        expect(compareVersions('23.3', '24.8')).toBeLessThan(0);
        expect(compareVersions('24.8', '24.8')).toBe(0);
    });

    it('handles differing part counts', () => {
        expect(compareVersions('24.8.1.2', '24.8')).toBeGreaterThan(0);
        expect(compareVersions('24.8', '24.8.0.0')).toBe(0);
    });
});

describe('isAvailableIn', () => {
    it('allows everything when the version is unset or auto', () => {
        expect(isAvailableIn('25.1', undefined)).toBe(true);
        expect(isAvailableIn('25.1', 'auto')).toBe(true);
    });

    it('allows functions no newer than the server', () => {
        expect(isAvailableIn('23.3', '24.8')).toBe(true);
        expect(isAvailableIn('24.8', '24.8')).toBe(true);
    });

    it('hides functions newer than the server', () => {
        expect(isAvailableIn('25.1', '24.8')).toBe(false);
    });

    it('allows functions with no recorded version', () => {
        expect(isAvailableIn(undefined, '24.8')).toBe(true);
    });
});

describe('functionDetail', () => {
    it('describes an aggregate', () => {
        expect(functionDetail(catalog.functionByName('quantile')!)).toContain('aggregate');
    });

    it('notes an alias', () => {
        const alias = catalog.functions().find(fn => fn.aliasTo);
        expect(functionDetail(alias!)).toContain(`alias of ${alias!.aliasTo}`);
    });

    it('notes the introducing version', () => {
        const withSince = catalog.functions().find(fn => fn.since);
        expect(functionDetail(withSince!)).toContain(`since ${withSince!.since}`);
    });
});
