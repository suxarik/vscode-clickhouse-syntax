/**
 * Tests for schema caching and refresh, and for server-side validation.
 */
import * as vscode from 'vscode';
import { SchemaSync } from '../client/schemaSync';
import { LiveValidator, createLiveDiagnosticCollection } from '../client/liveDiagnostics';
import { ConnectionManager } from '../client/connectionManager';
import { AnalysisCache } from '../analysis';
import { SchemaManager } from '../schemaManager';
import { makeSchemaManager, makeCatalog, docAt } from './helpers';

/** An in-memory file system for the cache directory. */
function installFileSystem() {
    const files = new Map<string, Uint8Array>();
    const fs = vscode.workspace.fs as unknown as Record<string, jest.Mock>;
    fs.readFile.mockImplementation(async (uri: vscode.Uri) => {
        const stored = files.get(uri.toString());
        if (!stored) throw new Error('ENOENT');
        return stored;
    });
    fs.writeFile.mockImplementation(async (uri: vscode.Uri, bytes: Uint8Array) => {
        files.set(uri.toString(), bytes);
    });
    fs.createDirectory.mockImplementation(async () => undefined);
    fs.delete.mockImplementation(async () => {
        files.clear();
    });
    return files;
}

let served: { tables: unknown[][]; columns: unknown[][]; fail?: Error } = { tables: [], columns: [] };
let queryCount = 0;

function stubFetch(): void {
    queryCount = 0;
    (globalThis as unknown as { fetch: unknown }).fetch = jest.fn(async (_url: string, init: RequestInit) => {
        queryCount++;
        const sql = String(init.body ?? '');
        if (served.fail) {
            return {
                ok: false,
                status: 500,
                headers: { get: () => null },
                text: async () => `Code: 999. DB::Exception: ${served.fail!.message}`,
                body: null,
            };
        }
        const respond = (columns: string[], rows: unknown[][]) =>
            [JSON.stringify(columns), JSON.stringify(columns.map(() => 'String')), ...rows.map(r => JSON.stringify(r))].join('\n');

        let body = respond(['x'], []);
        if (/version\(\)/.test(sql)) body = respond(['v'], [['24.8']]);
        else if (/system\.tables/.test(sql)) body = respond(['database', 'name', 'engine', 'comment'], served.tables);
        else if (/system\.columns/.test(sql)) {
            body = respond(
                ['database', 'table', 'name', 'type', 'default_expression', 'comment', 'compression_codec'],
                served.columns
            );
        }
        return {
            ok: true,
            status: 200,
            headers: { get: () => null },
            text: async () => body,
            body: null,
        };
    });
}

function makeContext() {
    const state: Record<string, unknown> = {};
    return {
        subscriptions: [],
        globalStorageUri: vscode.Uri.file('/global'),
        extensionUri: vscode.Uri.file('/ext'),
        workspaceState: {
            get: (key: string, fallback?: unknown) => (key in state ? state[key] : fallback),
            update: async (key: string, value: unknown) => {
                state[key] = value;
            },
        },
        secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined },
    } as unknown as vscode.ExtensionContext;
}

function setConfig(values: Record<string, unknown>): void {
    (vscode as unknown as { __setConfig(v: Record<string, unknown>): void }).__setConfig(values);
}

let schemaManager: SchemaManager;
let analysisCache: AnalysisCache;

beforeAll(async () => {
    schemaManager = await makeSchemaManager(null);
    analysisCache = new AnalysisCache(schemaManager, makeCatalog());
});

beforeEach(() => {
    jest.clearAllMocks();
    (vscode as unknown as { __resetConfig(): void }).__resetConfig();
    (vscode.workspace as unknown as { isTrusted: boolean }).isTrusted = true;
    served = {
        tables: [['analytics', 'events', 'MergeTree', '']],
        columns: [['analytics', 'events', 'event_id', 'UInt64', '', '', '']],
    };
    stubFetch();
    installFileSystem();
    schemaManager.setLiveSchema(null);
});

function makeSync() {
    setConfig({ connections: [{ name: 'prof', host: 'localhost' }] });
    const context = makeContext();
    const connections = new ConnectionManager(context);
    return { sync: new SchemaSync(context, connections, schemaManager, analysisCache), connections };
}

describe('refresh', () => {
    it('reads the schema and installs it', async () => {
        const { sync } = makeSync();
        const schema = await sync.refresh();
        expect(schema?.databases[0].name).toBe('analytics');
        expect(schemaManager.findTable('events')).toBeDefined();
        sync.dispose();
    });

    it('caches what it read', async () => {
        const files = installFileSystem();
        const { sync } = makeSync();
        await sync.refresh({ silent: true });
        expect([...files.keys()].some(key => key.includes('schema-cache'))).toBe(true);
        sync.dispose();
    });

    it('collapses concurrent refreshes into one', async () => {
        const { sync } = makeSync();
        await Promise.all([sync.refresh({ silent: true }), sync.refresh({ silent: true })]);
        // version + tables + columns, once.
        expect(queryCount).toBe(3);
        sync.dispose();
    });

    it('survives a server that refuses', async () => {
        served.fail = new Error('no rights on system.tables');
        const { sync } = makeSync();
        expect(await sync.refresh({ silent: true })).toBeUndefined();
        sync.dispose();
    });

    it('does nothing without a connection', async () => {
        setConfig({ connections: [] });
        const context = makeContext();
        const sync = new SchemaSync(context, new ConnectionManager(context), schemaManager, analysisCache);
        expect(await sync.refresh({ silent: true })).toBeUndefined();
        expect(queryCount).toBe(0);
        sync.dispose();
    });
});

describe('activate', () => {
    it('uses a fresh cache without going to the server', async () => {
        const { sync } = makeSync();
        await sync.refresh({ silent: true });
        const afterFirst = queryCount;

        schemaManager.setLiveSchema(null);
        await sync.activate();
        expect(queryCount).toBe(afterFirst);
        expect(schemaManager.findTable('events')).toBeDefined();
        sync.dispose();
    });

    it('refreshes in the background when the cache is stale', async () => {
        setConfig({
            connections: [{ name: 'prof', host: 'localhost' }],
            'schema.cacheTtlMinutes': 0.0001,
        });
        const context = makeContext();
        const connections = new ConnectionManager(context);
        const sync = new SchemaSync(context, connections, schemaManager, analysisCache);

        await sync.refresh({ silent: true });
        const afterFirst = queryCount;
        await new Promise(resolve => setTimeout(resolve, 20));
        await sync.activate();
        await new Promise(resolve => setTimeout(resolve, 20));

        expect(queryCount).toBeGreaterThan(afterFirst);
        sync.dispose();
    });

    it('does nothing when the schema source is the file', async () => {
        setConfig({ connections: [{ name: 'prof', host: 'localhost' }], 'schema.source': 'file' });
        const context = makeContext();
        const sync = new SchemaSync(context, new ConnectionManager(context), schemaManager, analysisCache);
        await sync.activate();
        expect(queryCount).toBe(0);
        sync.dispose();
    });
});

describe('switching profile', () => {
    it('never leaves the previous profile schema in place', async () => {
        setConfig({
            connections: [
                { name: 'a', host: 'localhost' },
                { name: 'b', host: 'localhost' },
            ],
        });
        const context = makeContext();
        const connections = new ConnectionManager(context);
        const sync = new SchemaSync(context, connections, schemaManager, analysisCache);

        await connections.setActiveProfile('a');
        await sync.refresh({ silent: true });
        expect(schemaManager.findTable('events')).toBeDefined();

        // The tables served for 'b' are different.
        served = { tables: [['other', 'things', 'Memory', '']], columns: [['other', 'things', 'x', 'String', '', '', '']] };
        await connections.setActiveProfile('b');
        await new Promise(resolve => setTimeout(resolve, 30));

        expect(schemaManager.findTable('events')).toBeUndefined();
        sync.dispose();
    });
});

describe('clearCache', () => {
    it('forgets the cache and the loaded schema', async () => {
        const { sync } = makeSync();
        await sync.refresh({ silent: true });
        await sync.clearCache();
        expect(schemaManager.getLiveSchema()).toBeNull();
        sync.dispose();
    });
});

describe('LiveValidator', () => {
    let collection: vscode.DiagnosticCollection;
    let sets: Array<{ uri: vscode.Uri; diagnostics: vscode.Diagnostic[] }>;

    function makeValidator() {
        setConfig({ connections: [{ name: 'prof', host: 'localhost' }] });
        const context = makeContext();
        const connections = new ConnectionManager(context);
        collection = createLiveDiagnosticCollection();
        sets = [];
        (collection.set as unknown as jest.Mock).mockImplementation(
            (uri: vscode.Uri, diagnostics: vscode.Diagnostic[]) => sets.push({ uri, diagnostics })
        );
        return new LiveValidator(connections, analysisCache, collection);
    }

    it('accepts a document the server likes', async () => {
        const validator = makeValidator();
        const { document } = docAt('SELECT 1');
        await validator.validate(document);
        expect(sets.at(-1)?.diagnostics).toEqual([]);
    });

    it('reports what the server rejects', async () => {
        served.fail = new Error('Unknown expression identifier `nope`');
        const validator = makeValidator();
        const { document } = docAt('SELECT nope FROM t');
        await validator.validate(document);
        expect(sets.at(-1)?.diagnostics).toHaveLength(1);
        expect(sets.at(-1)?.diagnostics[0].message).toContain('nope');
        expect(sets.at(-1)?.diagnostics[0].source).toContain('server');
    });

    it('does not send DDL to the server to be validated', async () => {
        const validator = makeValidator();
        const { document } = docAt('DROP TABLE t');
        await validator.validate(document);
        expect(queryCount).toBe(0);
    });

    it('validates each statement in a script', async () => {
        const validator = makeValidator();
        const { document } = docAt('SELECT 1; SELECT 2; SELECT 3');
        await validator.validate(document);
        expect(queryCount).toBe(3);
    });

    it('clears diagnostics for an empty document', async () => {
        const validator = makeValidator();
        const { document } = docAt('   ');
        await validator.validate(document);
        expect(collection.delete).toHaveBeenCalled();
    });

    it('says so when there is no connection', async () => {
        setConfig({ connections: [] });
        const context = makeContext();
        const validator = new LiveValidator(
            new ConnectionManager(context),
            analysisCache,
            createLiveDiagnosticCollection()
        );
        const { document } = docAt('SELECT 1');
        await validator.validate(document);
        expect(vscode.window.showWarningMessage).toHaveBeenCalled();
        expect(queryCount).toBe(0);
    });

    it('falls back to EXPLAIN PLAN on a server without QUERY TREE', async () => {
        const bodies: string[] = [];
        (globalThis as unknown as { fetch: unknown }).fetch = jest.fn(async (_url: string, init: RequestInit) => {
            const sql = String(init.body ?? '');
            bodies.push(sql);
            if (sql.includes('QUERY TREE')) {
                return {
                    ok: false,
                    status: 400,
                    headers: { get: () => null },
                    text: async () => "Code: 62. DB::Exception: Syntax error: unknown EXPLAIN kind 'QUERY TREE'",
                    body: null,
                };
            }
            return {
                ok: true,
                status: 200,
                headers: { get: () => null },
                text: async () => '["x"]\n["String"]\n',
                body: null,
            };
        });

        const validator = makeValidator();
        const { document } = docAt('SELECT 1');
        await validator.validate(document);

        expect(bodies.some(body => body.includes('QUERY TREE'))).toBe(true);
        expect(bodies.some(body => body.includes('EXPLAIN PLAN'))).toBe(true);
        expect(sets.at(-1)?.diagnostics).toEqual([]);
    });
});
