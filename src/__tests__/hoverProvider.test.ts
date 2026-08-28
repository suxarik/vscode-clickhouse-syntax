/**
 * Tests for hover documentation.
 */
import * as vscode from 'vscode';
import { buildHover } from '../providers/hoverProvider';
import { SchemaManager } from '../schemaManager';
import { Catalog } from '../catalog';
import { makeSchemaManager, makeConfig, makeCatalog, docAt } from './helpers';

let schemaManager: SchemaManager;
let catalog: Catalog;

beforeAll(async () => {
    schemaManager = await makeSchemaManager();
    catalog = makeCatalog();
});

/** Hover markdown at the `|` marker. */
async function hoverAt(sql: string, overrides: Record<string, unknown> = {}): Promise<string | undefined> {
    const { document, position } = docAt(sql);
    const hover = await buildHover(document, position, schemaManager, catalog, makeConfig(overrides));
    return hover ? (hover.contents as unknown as vscode.MarkdownString).value : undefined;
}

describe('functions', () => {
    it('documents a curated function', async () => {
        const md = await hoverAt('SELECT cou|nt() FROM events');
        expect(md).toContain('**count**');
        expect(md).toContain('Counts the number of rows');
        expect(md).toContain('count([expr])');
        expect(md).toContain('clickhouse.com/docs');
    });

    it('documents a function that only the catalog knows', async () => {
        const md = await hoverAt('SELECT toStartOfFifteenMi|nutes(ts) FROM events');
        expect(md).toContain('**toStartOfFifteenMinutes**');
        expect(md).toContain('fifteen');
    });

    it('shows argument documentation from the catalog', async () => {
        const md = await hoverAt('SELECT arrayM|ap(x -> x, a) FROM events');
        expect(md).toContain('arrayMap(func, arr1, ...)');
        expect(md).toContain('`func`');
    });

    it('shows an example', async () => {
        expect(await hoverAt('SELECT quan|tile(0.5)(x) FROM events')).toContain('**Example:**');
    });
});

describe('catalog objects', () => {
    it('documents a setting inside SETTINGS', async () => {
        const md = await hoverAt('SELECT a FROM events SETTINGS max_thr|eads = 4');
        expect(md).toContain('**max_threads**');
        expect(md).toContain('**Type:**');
        expect(md).toContain('**Default:**');
    });

    it('documents a table engine after ENGINE =', async () => {
        const md = await hoverAt('CREATE TABLE t (a UInt8) ENGINE = Replacing|MergeTree');
        expect(md).toContain('**ReplacingMergeTree**');
        expect(md).toContain('table engine');
    });

    it('documents an output format after FORMAT', async () => {
        const md = await hoverAt('SELECT a FROM events FORMAT JSONEach|Row');
        expect(md).toContain('**JSONEachRow**');
        expect(md).toContain('format');
    });

    it('documents a system table', async () => {
        const md = await hoverAt('SELECT a FROM system.query_l|og');
        expect(md).toContain('**system.query_log**');
        expect(md).toContain('**Columns:**');
    });

    it('documents a system table column', async () => {
        const md = await hoverAt('SELECT quer|y_duration_ms FROM system.query_log');
        expect(md).toContain('query_duration_ms');
        expect(md).toContain('system.query_log');
    });

    it('documents a data type', async () => {
        expect(await hoverAt('CREATE TABLE t (a UIn|t64)')).toContain('ClickHouse data type');
    });
});

describe('schema objects', () => {
    it('documents a table with its columns', async () => {
        const md = await hoverAt('SELECT 1 FROM ev|ents');
        expect(md).toContain('**analytics.events**');
        expect(md).toContain('MergeTree');
        expect(md).toContain('event_id');
    });

    it('documents a column with its type', async () => {
        const md = await hoverAt('SELECT event|_id FROM events');
        expect(md).toContain('**event_id**');
        expect(md).toContain('UInt64');
        expect(md).toContain('Unique id');
    });

    it('prefers the column of a table in scope', async () => {
        const md = await hoverAt('SELECT us|er_id FROM users');
        expect(md).toContain('`analytics.users`');
        expect(md).not.toContain('`analytics.events`');
    });

    it('lists every table when the column is ambiguous', async () => {
        const md = await hoverAt('SELECT us|er_id FROM numbers(10)');
        expect(md).toContain('`analytics.events`');
        expect(md).toContain('`analytics.users`');
    });
});

describe('nothing to say', () => {
    it('returns nothing for an unknown word', async () => {
        expect(await hoverAt('SELECT zzz|zzz FROM events')).toBeUndefined();
    });

    it('returns nothing on punctuation', async () => {
        expect(await hoverAt('SELECT a,| b FROM events')).toBeUndefined();
    });

    it('returns nothing inside a comment', async () => {
        expect(await hoverAt('-- cou|nt\nSELECT 1')).toBeUndefined();
    });

    it('returns nothing inside a string', async () => {
        expect(await hoverAt("SELECT 'cou|nt' FROM events")).toBeUndefined();
    });
});
