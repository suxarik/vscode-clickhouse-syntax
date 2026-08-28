/**
 * Tests for reading a schema out of system tables.
 */
import { countColumns, countTables, introspect, QueryCapable, tableStatistics } from '../client/introspection';
import { QueryResult } from '../client/types';

/** A client that answers each query from a canned table. */
function fakeClient(responses: Array<{ match: RegExp; columns: string[]; rows: unknown[][] }>): {
    client: QueryCapable;
    queries: string[];
} {
    const queries: string[] = [];
    const client: QueryCapable = {
        async query(sql: string): Promise<QueryResult> {
            queries.push(sql);
            const found = responses.find(response => response.match.test(sql));
            const columns = (found?.columns ?? []).map(name => ({ name, type: 'String' }));
            return {
                queryId: 'q',
                columns,
                rows: found?.rows ?? [],
                truncated: false,
                elapsedMs: 1,
            };
        },
    };
    return { client, queries };
}

const TABLES = {
    match: /system\.tables/,
    columns: ['database', 'name', 'engine', 'comment'],
    rows: [
        ['analytics', 'events', 'MergeTree', 'raw events'],
        ['analytics', 'users', 'ReplacingMergeTree', ''],
        ['other', 'thing', 'Memory', ''],
    ] as unknown[][],
};

const COLUMNS = {
    match: /system\.columns/,
    columns: ['database', 'table', 'name', 'type', 'default_expression', 'comment', 'compression_codec'],
    rows: [
        ['analytics', 'events', 'event_id', 'UInt64', '', 'the id', 'CODEC(ZSTD)'],
        ['analytics', 'events', 'ts', 'DateTime', 'now()', '', ''],
        ['analytics', 'users', 'user_id', 'UInt64', '', '', ''],
        ['other', 'thing', 'x', 'String', '', '', ''],
    ] as unknown[][],
};

const VERSION = { match: /version\(\)/, columns: ['v'], rows: [['24.8.1']] as unknown[][] };

describe('introspect', () => {
    it('builds databases, tables and columns', async () => {
        const { client } = fakeClient([VERSION, TABLES, COLUMNS]);
        const schema = await introspect(client, 'prod');

        expect(schema.serverVersion).toBe('24.8.1');
        expect(schema.profile).toBe('prod');
        expect(schema.databases.map(database => database.name).sort()).toEqual(['analytics', 'other']);
        expect(countTables(schema)).toBe(3);
        expect(countColumns(schema)).toBe(4);
    });

    it('keeps engines, comments, defaults and codecs', async () => {
        const { client } = fakeClient([VERSION, TABLES, COLUMNS]);
        const schema = await introspect(client, 'prod');
        const analytics = schema.databases.find(database => database.name === 'analytics')!;
        const events = analytics.tables.find(table => table.name === 'events')!;

        expect(events.engine).toBe('MergeTree');
        expect(events.description).toBe('raw events');
        expect(events.columns[0]).toMatchObject({ name: 'event_id', type: 'UInt64', description: 'the id', codec: 'CODEC(ZSTD)' });
        expect(events.columns[1]).toMatchObject({ name: 'ts', defaultValue: 'now()' });
    });

    it('keeps column order', async () => {
        const { client } = fakeClient([VERSION, TABLES, COLUMNS]);
        const schema = await introspect(client, 'prod');
        const events = schema.databases[0].tables.find(table => table.name === 'events')!;
        expect(events.columns.map(column => column.name)).toEqual(['event_id', 'ts']);
    });

    it('excludes the system and information schema databases by default', async () => {
        const { client, queries } = fakeClient([VERSION, TABLES, COLUMNS]);
        await introspect(client, 'prod');
        const tableQuery = queries.find(query => /system\.tables/.test(query))!;
        expect(tableQuery).toContain("'system'");
        expect(tableQuery).toContain("'INFORMATION_SCHEMA'");
    });

    it('can include the system database', async () => {
        const { client, queries } = fakeClient([VERSION, TABLES, COLUMNS]);
        await introspect(client, 'prod', { includeSystem: true });
        expect(queries.find(query => /system\.tables/.test(query))!).not.toContain("'system'");
    });

    it('skips a table whose columns cannot be read', async () => {
        const { client } = fakeClient([
            VERSION,
            TABLES,
            { ...COLUMNS, rows: COLUMNS.rows.filter(row => row[1] !== 'users') },
        ]);
        const schema = await introspect(client, 'prod');
        const analytics = schema.databases.find(database => database.name === 'analytics')!;
        expect(analytics.tables.map(table => table.name)).toEqual(['events']);
    });

    it('produces an empty schema for an empty server', async () => {
        const { client } = fakeClient([VERSION]);
        const schema = await introspect(client, 'prod');
        expect(schema.databases).toEqual([]);
        expect(countTables(schema)).toBe(0);
    });

    it('reads only, and bounds its own runtime', async () => {
        const seen: Array<Record<string, unknown>> = [];
        const client: QueryCapable = {
            async query(_sql, options) {
                seen.push(options ?? {});
                return { queryId: 'q', columns: [], rows: [], truncated: false, elapsedMs: 0 };
            },
        };
        await introspect(client, 'prod');
        expect(seen.every(options => options.readOnly === true)).toBe(true);
        expect(seen.every(options => typeof options.maxExecutionTime === 'number')).toBe(true);
    });
});

describe('tableStatistics', () => {
    it('reads counts and sizes', async () => {
        const { client } = fakeClient([
            {
                match: /system\.parts/,
                columns: ['database', 'table', 'rows', 'bytes_on_disk', 'uncompressed', 'parts'],
                rows: [['analytics', 'events', '1000000', '2048', '8192', '4']],
            },
        ]);
        expect(await tableStatistics(client)).toEqual([
            {
                database: 'analytics',
                table: 'events',
                rows: 1_000_000,
                bytesOnDisk: 2048,
                uncompressedBytes: 8192,
                parts: 4,
            },
        ]);
    });

    it('looks at active parts only', async () => {
        const { client, queries } = fakeClient([
            { match: /system\.parts/, columns: ['database'], rows: [] },
        ]);
        await tableStatistics(client);
        expect(queries[0]).toContain('WHERE active');
    });
});
