/**
 * Tests for the explorer tree, schema cache naming, history and server validation.
 */
import * as vscode from 'vscode';
import { ExplorerNode, ExplorerProvider, engineIcon, qualifiedName } from '../client/explorerView';
import { previewStatement } from '../client/explorerCommands';
import { ConnectionManager } from '../client/connectionManager';
import { cacheFileName, isStale } from '../client/schemaSync';
import { fetchProfile, QueryHistory } from '../client/history';
import { parseErrorPosition } from '../client/liveDiagnostics';
import { QueryCapable } from '../client/introspection';
import { QueryResult } from '../client/types';
import { makeCatalog, makeSchemaManager } from './helpers';
import { SchemaManager } from '../schemaManager';

function makeContext() {
    const state: Record<string, unknown> = {};
    return {
        subscriptions: [],
        workspaceState: {
            get: (key: string, fallback?: unknown) => (key in state ? state[key] : fallback),
            update: async (key: string, value: unknown) => {
                state[key] = value;
            },
        },
        secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined },
    } as unknown as vscode.ExtensionContext;
}

beforeEach(() => {
    jest.clearAllMocks();
    (vscode as unknown as { __resetConfig(): void }).__resetConfig();
    (vscode.workspace as unknown as { isTrusted: boolean }).isTrusted = true;
});

describe('qualifiedName', () => {
    it('leaves plain identifiers alone', () => {
        expect(qualifiedName('analytics', 'events')).toBe('analytics.events');
    });

    it('quotes anything that needs it', () => {
        expect(qualifiedName('my db', 'events')).toBe('`my db`.events');
        expect(qualifiedName('db', 'my-table')).toBe('db.`my-table`');
    });
});

describe('explorer tree', () => {
    let schemaManager: SchemaManager;

    beforeAll(async () => {
        schemaManager = await makeSchemaManager();
    });

    function makeExplorer() {
        (vscode as unknown as { __setConfig(v: Record<string, unknown>): void }).__setConfig({
            connections: [{ name: 'p', host: 'h' }],
        });
        const connections = new ConnectionManager(makeContext());
        return { explorer: new ExplorerProvider(schemaManager, connections), connections };
    }

    it('lists the server and then its databases at the root', () => {
        const { explorer } = makeExplorer();
        expect(explorer.getChildren()).toEqual([
            { kind: 'server' },
            { kind: 'database', name: 'analytics' },
        ]);
    });

    it('lists a database\'s tables, sorted', () => {
        const { explorer } = makeExplorer();
        const tables = explorer.getChildren({ kind: 'database', name: 'analytics' });
        expect(tables.map(node => (node.kind === 'table' ? node.table.name : ''))).toEqual(['events', 'users']);
    });

    it('lists a table\'s columns in order', () => {
        const { explorer } = makeExplorer();
        const [table] = explorer.getChildren({ kind: 'database', name: 'analytics' });
        const columns = explorer.getChildren(table);
        expect(columns.map(node => (node.kind === 'column' ? node.column.name : ''))).toEqual([
            'event_id',
            'event_time',
            'user_id',
            'tags',
        ]);
    });

    it('is empty when there is no schema, so the welcome content can show', () => {
        // A dead-end message node would hide the view's welcome buttons.
        const explorer = new ExplorerProvider(
            {
                getSchema: () => null,
                getTables: () => [],
                onDidChangeSchema: () => ({ dispose: () => undefined }),
            } as unknown as SchemaManager,
            new ConnectionManager(makeContext())
        );
        expect(explorer.getChildren()).toEqual([]);
    });

    it('describes a table with its engine', () => {
        const { explorer } = makeExplorer();
        const [table] = explorer.getChildren({ kind: 'database', name: 'analytics' });
        const item = explorer.getTreeItem(table);
        expect(item.label).toBe('events');
        expect(String(item.description)).toContain('MergeTree');
        expect(item.contextValue).toBe('clickhouse.table');
    });

    it('describes a column with its type', () => {
        const { explorer } = makeExplorer();
        const [table] = explorer.getChildren({ kind: 'database', name: 'analytics' });
        const [column] = explorer.getChildren(table);
        const item = explorer.getTreeItem(column);
        expect(item.label).toBe('event_id');
        expect(item.description).toBe('UInt64');
        expect(item.contextValue).toBe('clickhouse.column');
    });
});

describe('schema cache naming', () => {
    it('makes a profile name safe for a filename', () => {
        expect(cacheFileName('prod')).toMatch(/^prod\.[0-9a-f]+\.json$/);
        expect(cacheFileName('my/prod:1')).not.toContain('/');
        expect(cacheFileName('my/prod:1')).not.toContain(':');
    });

    it('does not collide for names that differ only in stripped characters', () => {
        expect(cacheFileName('a/b')).not.toBe(cacheFileName('a:b'));
    });

    it('is stable for the same name', () => {
        expect(cacheFileName('prod')).toBe(cacheFileName('prod'));
    });
});

describe('isStale', () => {
    const schema = { version: '1.0', databases: [], serverVersion: '24.8', profile: 'p', fetchedAt: Date.now() };

    it('is fresh within the window', () => {
        expect(isStale(schema, 60)).toBe(false);
    });

    it('is stale past the window', () => {
        expect(isStale({ ...schema, fetchedAt: Date.now() - 2 * 60 * 60_000 }, 60)).toBe(true);
    });

    it('never expires when the TTL is zero', () => {
        expect(isStale({ ...schema, fetchedAt: 0 }, 0)).toBe(false);
    });
});

describe('query history', () => {
    it('records newest first', async () => {
        const history = new QueryHistory(makeContext());
        await history.record({ sql: 'SELECT 1', profile: 'p', queryId: 'a', at: 1 });
        await history.record({ sql: 'SELECT 2', profile: 'p', queryId: 'b', at: 2 });
        expect(history.entries().map(entry => entry.sql)).toEqual(['SELECT 2', 'SELECT 1']);
        expect(history.latest()?.sql).toBe('SELECT 2');
    });

    it('ignores an empty statement', async () => {
        const history = new QueryHistory(makeContext());
        await history.record({ sql: '   ', profile: 'p', queryId: 'a', at: 1 });
        expect(history.entries()).toEqual([]);
    });

    it('caps how much it keeps', async () => {
        const history = new QueryHistory(makeContext());
        for (let i = 0; i < 250; i++) {
            await history.record({ sql: `SELECT ${i}`, profile: 'p', queryId: String(i), at: i });
        }
        expect(history.entries().length).toBeLessThanOrEqual(200);
        expect(history.entries()[0].sql).toBe('SELECT 249');
    });

    it('keeps failures, which are the ones worth revisiting', async () => {
        const history = new QueryHistory(makeContext());
        await history.record({ sql: 'SELECT bad', profile: 'p', queryId: 'a', at: 1, error: 'boom' });
        expect(history.latest()?.error).toBe('boom');
    });

    it('clears', async () => {
        const history = new QueryHistory(makeContext());
        await history.record({ sql: 'SELECT 1', profile: 'p', queryId: 'a', at: 1 });
        await history.clear();
        expect(history.entries()).toEqual([]);
    });
});

describe('pinned history entries', () => {
    it('survives the cap', async () => {
        const history = new QueryHistory(makeContext());
        await history.record({ sql: 'SELECT keep', profile: 'p', queryId: 'keep', at: 0 });
        await history.setPinned('keep', true);
        for (let i = 0; i < 250; i++) {
            await history.record({ sql: `SELECT ${i}`, profile: 'p', queryId: String(i), at: i + 1 });
        }
        expect(history.entries().some(entry => entry.sql === 'SELECT keep')).toBe(true);
        // The cap still applies to everything else.
        expect(history.entries().filter(entry => !entry.pinned).length).toBeLessThanOrEqual(200);
    });

    it('survives clearing, unless clearing is explicit about it', async () => {
        const history = new QueryHistory(makeContext());
        await history.record({ sql: 'SELECT keep', profile: 'p', queryId: 'keep', at: 1 });
        await history.record({ sql: 'SELECT drop', profile: 'p', queryId: 'drop', at: 2 });
        await history.setPinned('keep', true);

        expect(await history.clear()).toBe(1);
        expect(history.entries().map(entry => entry.sql)).toEqual(['SELECT keep']);

        expect(await history.clear({ includePinned: true })).toBe(0);
        expect(history.entries()).toEqual([]);
    });

    it('sorts pinned first, whatever their age', async () => {
        const history = new QueryHistory(makeContext());
        await history.record({ sql: 'SELECT old', profile: 'p', queryId: 'old', at: 1 });
        await history.setPinned('old', true);
        await history.record({ sql: 'SELECT new', profile: 'p', queryId: 'new', at: 2 });
        expect(history.entries().map(entry => entry.sql)).toEqual(['SELECT old', 'SELECT new']);
    });

    it('still profiles the query that actually ran last', async () => {
        // An old pin sorts to the top of the list, but 'last query' means last run.
        const history = new QueryHistory(makeContext());
        await history.record({ sql: 'SELECT old', profile: 'p', queryId: 'old', at: 1 });
        await history.setPinned('old', true);
        await history.record({ sql: 'SELECT new', profile: 'p', queryId: 'new', at: 2 });
        expect(history.latest()?.queryId).toBe('new');
    });

    it('unpins, and forgets the label with it', async () => {
        const history = new QueryHistory(makeContext());
        await history.record({ sql: 'SELECT 1', profile: 'p', queryId: 'a', at: 1 });
        await history.setPinned('a', true, 'daily rollup');
        expect(history.entries()[0].label).toBe('daily rollup');

        await history.setPinned('a', false);
        expect(history.entries()[0].pinned).toBeUndefined();
        expect(history.entries()[0].label).toBeUndefined();
    });

    it('reports an unknown query id rather than inventing an entry', async () => {
        const history = new QueryHistory(makeContext());
        expect(await history.setPinned('nope', true)).toBeUndefined();
        expect(history.entries()).toEqual([]);
    });
});

describe('fetchProfile', () => {
    function client(rows: unknown[][]): QueryCapable & { queries: string[] } {
        const queries: string[] = [];
        return {
            queries,
            async query(sql: string): Promise<QueryResult> {
                queries.push(sql);
                return {
                    queryId: 'q',
                    columns: [
                        'query_duration_ms', 'read_rows', 'read_bytes', 'result_rows',
                        'memory_usage', 'threads', 'exception',
                    ].map(name => ({ name, type: 'String' })),
                    rows,
                    truncated: false,
                    elapsedMs: 1,
                };
            },
        };
    }

    it('reads the counters from system.query_log', async () => {
        const fake = client([['120', '1000', '4096', '10', '65536', '8', '']]);
        expect(await fetchProfile(fake, 'abc')).toEqual({
            queryId: 'abc',
            durationMs: 120,
            readRows: 1000,
            readBytes: 4096,
            resultRows: 10,
            memoryBytes: 65536,
            threads: 8,
        });
    });

    it('reports an exception when there was one', async () => {
        const fake = client([['1', '0', '0', '0', '0', '1', 'Table does not exist']]);
        expect((await fetchProfile(fake, 'abc'))?.exception).toBe('Table does not exist');
    });

    it('returns nothing when the log has not caught up', async () => {
        expect(await fetchProfile(client([]), 'abc')).toBeUndefined();
    });

    it('escapes the query id', async () => {
        const fake = client([]);
        await fetchProfile(fake, "a'b");
        expect(fake.queries[0]).toContain("'a''b'");
    });

    it('skips the QueryStart row, which has no counters yet', async () => {
        const fake = client([]);
        await fetchProfile(fake, 'abc');
        expect(fake.queries[0]).toContain("type != 'QueryStart'");
    });
});

describe('parseErrorPosition', () => {
    it('finds the offset ClickHouse reports', () => {
        // ClickHouse counts from 1; the editor counts from 0.
        expect(parseErrorPosition("Syntax error: failed at position 15 ('FROM')")).toBe(14);
    });

    it('returns nothing when there is no position', () => {
        expect(parseErrorPosition('Table x does not exist')).toBeUndefined();
    });

    it('does not go negative', () => {
        expect(parseErrorPosition('failed at position 0')).toBe(0);
    });
});

describe('server validation ranges', () => {
    it('discounts the EXPLAIN prefix from a reported position', () => {
        // `EXPLAIN QUERY TREE ` is 19 characters; position 25 (1-based) in what
        // the server saw is offset 5 in the statement itself.
        const reported = parseErrorPosition('Syntax error: failed at position 25 (x)');
        expect(reported).toBe(24);
        expect(reported! - 'EXPLAIN QUERY TREE '.length).toBe(5);
    });
});

describe('previewStatement', () => {
    it('limits to the configured row count', () => {
        (vscode as unknown as { __setConfig(v: Record<string, unknown>): void }).__setConfig({
            'query.previewRows': 100,
        });
        expect(previewStatement('analytics', 'events')).toBe('SELECT * FROM analytics.events LIMIT 100');
    });

    it('defaults to a preview-sized count, not a thousand rows', () => {
        // The menu item does not name a number, but it must still be a preview.
        expect(previewStatement('analytics', 'events')).toContain('LIMIT 100');
    });

    it('honours a different configured count', () => {
        (vscode as unknown as { __setConfig(v: Record<string, unknown>): void }).__setConfig({
            'query.previewRows': 25,
        });
        expect(previewStatement('analytics', 'events')).toContain('LIMIT 25');
    });

    it('reads the whole table when the count is zero', () => {
        (vscode as unknown as { __setConfig(v: Record<string, unknown>): void }).__setConfig({
            'query.previewRows': 0,
        });
        expect(previewStatement('analytics', 'events')).toBe('SELECT * FROM analytics.events');
    });

    it('quotes names that need it', () => {
        expect(previewStatement('my db', 'my-table', 10)).toBe('SELECT * FROM `my db`.`my-table` LIMIT 10');
    });
});

describe('the explorer and a schema that arrives later', () => {
    it('redraws itself when the background sync finishes', async () => {
        // The schema is fetched after the tree has already been drawn empty.
        // Without a signal the view keeps offering "No tables loaded yet"
        // while a perfectly good schema sits behind it.
        const schemaManager = await makeSchemaManager();
        const explorer = new ExplorerProvider(schemaManager, {
            activeProfileName: () => 'local',
            client: async () => undefined,
        } as unknown as ConnectionManager);

        let redrawn = 0;
        explorer.onDidChangeTreeData(() => {
            redrawn += 1;
        });

        schemaManager.setLiveSchema({
            databases: [{ name: 'demo', tables: [{ name: 'events', columns: [], engine: 'MergeTree' }] }],
        });

        expect(redrawn).toBeGreaterThan(0);
    });
});

describe('engineIcon', () => {
    it('tells the MergeTree variants apart, because they read differently', () => {
        // A ReplacingMergeTree needs FINAL; a SummingMergeTree does not. The
        // engine is already in the description, but an icon is what gets
        // noticed while scanning a long list.
        expect(engineIcon('MergeTree')).toBe('database');
        expect(engineIcon('ReplacingMergeTree')).toBe('versions');
        expect(engineIcon('SummingMergeTree')).toBe('graph');
        expect(engineIcon('AggregatingMergeTree')).toBe('graph');
        expect(engineIcon('CollapsingMergeTree')).toBe('fold');
    });

    it('treats a Replicated or Shared engine as the family it belongs to', () => {
        expect(engineIcon('ReplicatedReplacingMergeTree')).toBe(engineIcon('ReplacingMergeTree'));
        expect(engineIcon('SharedMergeTree')).toBe(engineIcon('MergeTree'));
    });

    it('separates the things that are not really tables', () => {
        expect(engineIcon('View')).toBe('eye');
        expect(engineIcon('MaterializedView')).toBe('zap');
        expect(engineIcon('Dictionary')).toBe('book');
        expect(engineIcon('Distributed')).toBe('type-hierarchy');
        expect(engineIcon('Null')).toBe('circle-slash');
    });

    it('marks what the data actually lives somewhere else', () => {
        for (const engine of ['S3', 'IcebergS3', 'DeltaLake', 'AzureBlobStorage', 'HDFS', 'URL', 'File']) {
            expect(engineIcon(engine)).toBe('cloud');
        }
        for (const engine of ['MySQL', 'PostgreSQL', 'MongoDB', 'SQLite', 'Redis', 'BigQuery']) {
            expect(engineIcon(engine)).toBe('plug');
        }
        for (const engine of ['Kafka', 'RabbitMQ', 'NATS', 'S3Queue']) {
            expect(engineIcon(engine)).toBe('radio-tower');
        }
    });

    it('falls back rather than leaving a table with no icon at all', () => {
        expect(engineIcon('')).toBe('table');
        expect(engineIcon(undefined)).toBe('table');
        expect(engineIcon('SomethingClickHouseAddedLastWeek')).toBe('table');
    });

    it('resolves every engine this ClickHouse reports, mostly to something specific', () => {
        const catalog = makeCatalog();
        const engines = catalog.engines();
        expect(engines.length).toBeGreaterThan(50);

        const unrecognised: string[] = [];
        for (const engine of engines) {
            const icon = engineIcon(engine.name);
            expect(icon.length).toBeGreaterThan(0);
            if (icon === 'table') unrecognised.push(engine.name);
        }

        // A map that quietly fell back for most engines would pass a
        // "returns a string" check and still show one icon everywhere.
        expect(unrecognised.length).toBeLessThan(engines.length / 3);
    });
});

describe('the server at the top of the explorer', () => {
    /** An explorer whose server shape has already been answered. */
    function explorerKnowing(shape: { cluster: string; hosts: number } | undefined) {
        const schemaManager = {
            getSchema: () => ({ databases: [{ name: 'demo', tables: [] }] }),
            getTables: () => [],
            onDidChangeSchema: () => ({ dispose: () => undefined }),
        } as unknown as SchemaManager;

        const explorer = new ExplorerProvider(schemaManager, {
            activeProfileName: () => 'local',
            client: async () => undefined,
        } as unknown as ConnectionManager);

        (explorer as unknown as { serverShape?: unknown }).serverShape = { profile: 'local', cluster: shape };
        return explorer;
    }

    it('puts the server above the databases', () => {
        const children = explorerKnowing(undefined).getChildren();
        expect(children[0]).toMatchObject({ kind: 'server' });
        expect(children.slice(1).every(node => node.kind === 'database')).toBe(true);
    });

    it('shows nothing extra when there is no schema, so the welcome can offer to connect', () => {
        const explorer = new ExplorerProvider(
            {
                getSchema: () => null,
                getTables: () => [],
                onDidChangeSchema: () => ({ dispose: () => undefined }),
            } as unknown as SchemaManager,
            { activeProfileName: () => 'local', client: async () => undefined } as unknown as ConnectionManager
        );
        expect(explorer.getChildren()).toEqual([]);
    });

    it('draws a single node differently from a cluster', () => {
        const single = explorerKnowing(undefined).getChildren()[0];
        const clustered = explorerKnowing({ cluster: 'analytics', hosts: 4 }).getChildren()[0];

        const iconOf = (node: ExplorerNode, explorer: ExplorerProvider) =>
            (explorer.getTreeItem(node).iconPath as vscode.ThemeIcon).id;

        expect(iconOf(single, explorerKnowing(undefined))).toBe('server');
        expect(iconOf(clustered, explorerKnowing({ cluster: 'analytics', hosts: 4 }))).toBe('type-hierarchy');
    });

    it('says what the server is, beside its name', () => {
        const explorer = explorerKnowing({ cluster: 'analytics', hosts: 4 });
        const item = explorer.getTreeItem(explorer.getChildren()[0]);

        expect(item.label).toBe('local');
        expect(String(item.description)).toContain('analytics');
        expect(String(item.description)).toContain('4');
    });

    it('calls a single node a single node rather than leaving it blank', () => {
        const explorer = explorerKnowing(undefined);
        expect(String(explorer.getTreeItem(explorer.getChildren()[0]).description)).toContain('single node');
    });

    it('marks a cluster so the menu can offer to show it', () => {
        const clustered = explorerKnowing({ cluster: 'analytics', hosts: 4 });
        const single = explorerKnowing(undefined);

        expect(clustered.getTreeItem(clustered.getChildren()[0]).contextValue).toBe('clickhouse.cluster');
        expect(single.getTreeItem(single.getChildren()[0]).contextValue).toBe('clickhouse.server');
    });
});
