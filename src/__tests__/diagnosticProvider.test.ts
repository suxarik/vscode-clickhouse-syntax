/**
 * Tests for diagnostics.
 */
import * as vscode from 'vscode';
import { computeDiagnostics } from '../providers/diagnosticProvider';
import { SchemaManager } from '../schemaManager';
import { makeSchemaManager, makeConfig, makeCatalog, docAt } from './helpers';

let schemaManager: SchemaManager;

beforeAll(async () => {
    schemaManager = await makeSchemaManager();
});

function codesFor(sql: string, overrides: Record<string, unknown> = {}): string[] {
    const { document } = docAt(sql);
    return computeDiagnostics(document, schemaManager, makeConfig(overrides)).map(d => String(d.code));
}

function diagnosticsFor(sql: string, overrides: Record<string, unknown> = {}): vscode.Diagnostic[] {
    const { document } = docAt(sql);
    return computeDiagnostics(document, schemaManager, makeConfig(overrides));
}

describe('schema validation', () => {
    it('flags an unknown table', () => {
        expect(codesFor('SELECT event_id FROM ghosts')).toContain('unknown-table');
    });

    it('accepts a known table', () => {
        expect(codesFor('SELECT event_id FROM events')).not.toContain('unknown-table');
    });

    it('accepts a qualified known table', () => {
        expect(codesFor('SELECT event_id FROM analytics.events')).not.toContain('unknown-table');
    });

    it('does not flag a CTE as an unknown table', () => {
        expect(codesFor('WITH recent AS (SELECT 1) SELECT * FROM recent')).not.toContain('unknown-table');
    });

    it('does not flag an alias as an unknown table', () => {
        expect(codesFor('SELECT e.event_id FROM events AS e JOIN e ON 1')).not.toContain('unknown-table');
    });

    it('points at the table, not the first textual match of its name', () => {
        const sql = 'SELECT ghosts FROM ghosts';
        const [diagnostic] = diagnosticsFor(sql).filter(d => d.code === 'unknown-table');
        const { document } = docAt(sql);
        expect(document.getText(diagnostic.range)).toBe('ghosts');
        expect(document.offsetAt(diagnostic.range.start)).toBe(sql.lastIndexOf('ghosts'));
    });

    it('can be turned off', () => {
        expect(codesFor('SELECT 1 FROM ghosts', { 'diagnostics.schemaValidation': false })).not.toContain(
            'unknown-table'
        );
    });
});

describe('best practices', () => {
    it('flags SELECT *', () => {
        expect(codesFor('SELECT * FROM events')).toContain('best-practice-select-star');
    });

    it('does not flag a multiplication', () => {
        expect(codesFor('SELECT a * b FROM events')).not.toContain('best-practice-select-star');
    });

    it('flags a missing FINAL on ReplacingMergeTree', () => {
        expect(codesFor('SELECT user_id FROM users')).toContain('missing-final');
    });

    it('accepts FINAL when present', () => {
        expect(codesFor('SELECT user_id FROM users FINAL')).not.toContain('missing-final');
    });

    it('does not flag a plain MergeTree table', () => {
        expect(codesFor('SELECT event_id FROM events')).not.toContain('missing-final');
    });

    it('flags NOT IN', () => {
        expect(codesFor('SELECT event_id FROM events WHERE user_id NOT IN (1, 2)')).toContain('inefficient-not-in');
    });

    it('flags LIMIT without ORDER BY', () => {
        expect(codesFor('SELECT event_id FROM events LIMIT 10')).toContain('unbounded-limit');
    });

    it('accepts LIMIT with ORDER BY', () => {
        expect(codesFor('SELECT event_id FROM events ORDER BY event_id LIMIT 10')).not.toContain('unbounded-limit');
    });

    it('judges LIMIT per statement, not per document', () => {
        const codes = codesFor('SELECT a FROM events ORDER BY a LIMIT 1; SELECT b FROM events LIMIT 1');
        expect(codes.filter(c => c === 'unbounded-limit')).toHaveLength(1);
    });

    it('flags OR in a filter', () => {
        expect(codesFor('SELECT event_id FROM events WHERE a = 1 OR b = 2')).toContain('or-index-inefficiency');
    });

    it('ignores OR that appears before WHERE', () => {
        expect(codesFor('SELECT event_id FROM events')).not.toContain('or-index-inefficiency');
    });

    it('ignores keywords inside strings and comments', () => {
        expect(codesFor("SELECT 'NOT IN' AS s FROM events")).not.toContain('inefficient-not-in');
        expect(codesFor('-- SELECT *\nSELECT event_id FROM events')).not.toContain('best-practice-select-star');
    });

    it('can be turned off', () => {
        const codes = codesFor('SELECT * FROM events LIMIT 1', { 'diagnostics.bestPractices': false });
        expect(codes).toEqual([]);
    });
});

describe('diagnostic metadata', () => {
    it('tags every diagnostic with the extension source', () => {
        for (const diagnostic of diagnosticsFor('SELECT * FROM ghosts LIMIT 1')) {
            expect(diagnostic.source).toBe('clickhouse');
        }
    });
});

describe('SETTINGS validation', () => {
    it('flags an unknown setting', async () => {
        const catalog = makeCatalog();
        const { document } = docAt('SELECT a FROM events SETTINGS not_a_real_setting = 1');
        const codes = computeDiagnostics(document, schemaManager, makeConfig(), catalog).map(d => String(d.code));
        expect(codes).toContain('unknown-setting');
    });

    it('accepts a real setting', async () => {
        const catalog = makeCatalog();
        const { document } = docAt('SELECT a FROM events SETTINGS max_threads = 8');
        const codes = computeDiagnostics(document, schemaManager, makeConfig(), catalog).map(d => String(d.code));
        expect(codes).not.toContain('unknown-setting');
    });

    it('accepts MergeTree settings in DDL', async () => {
        const catalog = makeCatalog();
        const { document } = docAt(
            'CREATE TABLE t (a UInt8) ENGINE = MergeTree ORDER BY a SETTINGS index_granularity = 8192'
        );
        const codes = computeDiagnostics(document, schemaManager, makeConfig(), catalog).map(d => String(d.code));
        expect(codes).not.toContain('unknown-setting');
    });

    it('flags an obviously wrong value type', async () => {
        const catalog = makeCatalog();
        const { document } = docAt("SELECT a FROM events SETTINGS max_threads = 'lots'");
        const codes = computeDiagnostics(document, schemaManager, makeConfig(), catalog).map(d => String(d.code));
        expect(codes).toContain('setting-type-mismatch');
    });

    it('accepts a sized numeric literal', async () => {
        const catalog = makeCatalog();
        const { document } = docAt("SELECT a FROM events SETTINGS max_memory_usage = '10G'");
        const codes = computeDiagnostics(document, schemaManager, makeConfig(), catalog).map(d => String(d.code));
        expect(codes).not.toContain('setting-type-mismatch');
    });

    it('notes a non-production setting', async () => {
        const catalog = makeCatalog();
        const experimental = catalog.settings().find(s => s.tier && !s.mergeTree);
        expect(experimental).toBeDefined();
        const { document } = docAt(`SELECT a FROM events SETTINGS ${experimental!.name} = 1`);
        const codes = computeDiagnostics(document, schemaManager, makeConfig(), catalog).map(d => String(d.code));
        expect(codes).toContain('experimental-setting');
    });

    it('can be turned off', async () => {
        const catalog = makeCatalog();
        const { document } = docAt('SELECT a FROM events SETTINGS not_a_real_setting = 1');
        const codes = computeDiagnostics(
            document,
            schemaManager,
            makeConfig({ 'diagnostics.settingsValidation': false }),
            catalog
        ).map(d => String(d.code));
        expect(codes).not.toContain('unknown-setting');
    });

    it('does nothing without a catalog', () => {
        const { document } = docAt('SELECT a FROM events SETTINGS not_a_real_setting = 1');
        const codes = computeDiagnostics(document, schemaManager, makeConfig()).map(d => String(d.code));
        expect(codes).not.toContain('unknown-setting');
    });
});
