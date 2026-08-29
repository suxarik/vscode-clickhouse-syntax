/**
 * Tests for schema diffing and scaffolding.
 *
 * Every statement these produce was run against a real ClickHouse before being
 * fixed in a test, because SQL that looks right and is refused by the server is
 * the failure mode that matters here.
 */
import {
    Change,
    columnClause,
    createTableSql,
    diffSchema,
    keyColumns,
    quoteIdentifier,
    renderMigration,
} from '../migrate/diff';
import { distributedTableSql, localTableSql, rollupSql, scaffold } from '../migrate/scaffold';
import { parseColumnList } from '../migrate/commands';
import { ClickHouseSchema, SchemaColumn, SchemaTable } from '../types';

function table(columns: SchemaColumn[], options: Partial<SchemaTable> = {}): SchemaTable {
    return { name: 'events', engine: 'MergeTree', columns, ...options };
}

function schema(tables: SchemaTable[], database = 'app'): ClickHouseSchema {
    return { databases: [{ name: database, tables }] };
}

const KEYED = { engineOptions: { orderBy: '(event_date, user_id)', partitionBy: 'toYYYYMM(event_date)' } };

const kinds = (changes: Change[]) => changes.map(change => `${change.kind}:${change.column ?? change.table ?? change.database}`);

describe('quoting', () => {
    it('leaves a plain name alone and quotes anything else', () => {
        expect(quoteIdentifier('events')).toBe('events');
        expect(quoteIdentifier('_x1')).toBe('_x1');
        expect(quoteIdentifier('my table')).toBe('`my table`');
        expect(quoteIdentifier('order')).toBe('order');
        expect(quoteIdentifier('a`b')).toBe('`a\\`b`');
    });
});

describe('the column clause', () => {
    it('carries the modifiers ClickHouse accepts, in the order it wants them', () => {
        expect(
            columnClause({
                name: 'payload',
                type: 'String',
                defaultValue: "''",
                codec: 'ZSTD(3)',
                ttl: 'event_date + INTERVAL 30 DAY',
                comment: 'the body',
            })
        ).toBe("payload String DEFAULT '' CODEC(ZSTD(3)) TTL event_date + INTERVAL 30 DAY COMMENT 'the body'");
    });

    it('escapes a comment that would otherwise end the string', () => {
        expect(columnClause({ name: 'a', type: 'String', comment: "it's here" })).toContain("'it\\'s here'");
    });

    it('falls back to the description when there is no comment', () => {
        expect(columnClause({ name: 'a', type: 'String', description: 'from the file' })).toContain(
            "COMMENT 'from the file'"
        );
    });
});

describe('diffing a table', () => {
    const intended = schema([
        table([
            { name: 'event_date', type: 'Date' },
            { name: 'user_id', type: 'UInt64' },
            { name: 'payload', type: 'String' },
        ]),
    ]);

    it('adds a column the server does not have, positioned where the file puts it', () => {
        const actual = schema([table([{ name: 'event_date', type: 'Date' }, { name: 'user_id', type: 'UInt64' }])]);
        const [change] = diffSchema(intended, actual);
        expect(change.kind).toBe('addColumn');
        expect(change.destructive).toBe(false);
        expect(change.sql).toBe(
            'ALTER TABLE app.events ADD COLUMN IF NOT EXISTS payload String AFTER user_id;'
        );
    });

    it('puts a new leading column first rather than at the end', () => {
        const actual = schema([table([{ name: 'user_id', type: 'UInt64' }, { name: 'payload', type: 'String' }])]);
        expect(diffSchema(intended, actual)[0].sql).toContain('FIRST');
    });

    it('treats a column only the server has as destructive, and says why', () => {
        const actual = schema([
            table([
                { name: 'event_date', type: 'Date' },
                { name: 'user_id', type: 'UInt64' },
                { name: 'payload', type: 'String' },
                { name: 'legacy', type: 'String' },
            ]),
        ]);
        const [change] = diffSchema(intended, actual);
        expect(change).toMatchObject({ kind: 'dropColumn', destructive: true });
        expect(change.note).toContain('deletes its data');
    });

    it('modifies a changed type on an ordinary column', () => {
        const actual = schema([
            table([
                { name: 'event_date', type: 'Date' },
                { name: 'user_id', type: 'UInt64' },
                { name: 'payload', type: 'FixedString(16)' },
            ]),
        ]);
        const [change] = diffSchema(intended, actual);
        expect(change).toMatchObject({ kind: 'modifyColumn', destructive: true });
        expect(change.sql).toBe('ALTER TABLE app.events MODIFY COLUMN payload String;');
    });

    it('refuses to emit an ALTER on a key column, because the server refuses it', () => {
        // Verified against ClickHouse 26.7: ALTER_OF_COLUMN_IS_FORBIDDEN, since
        // the change would alter the representation of the primary key.
        const keyed = schema([
            table([{ name: 'event_date', type: 'Date' }, { name: 'user_id', type: 'UInt64' }], KEYED),
        ]);
        const actual = schema([
            table([{ name: 'event_date', type: 'Date' }, { name: 'user_id', type: 'UInt32' }], KEYED),
        ]);
        const [change] = diffSchema(keyed, actual);
        expect(change.kind).toBe('rebuildRequired');
        expect(change.sql).toBeUndefined();
        expect(change.note).toContain('INSERT SELECT');
    });

    it('ignores spacing when comparing types', () => {
        const actual = schema([
            table([
                { name: 'event_date', type: 'Date' },
                { name: 'user_id', type: 'UInt64' },
                { name: 'payload', type: ' string ' },
            ]),
        ]);
        expect(diffSchema(intended, actual)).toEqual([]);
    });

    it('notices a changed comment without touching the type', () => {
        const withComment = schema([table([{ name: 'a', type: 'String', comment: 'new' }])]);
        const actual = schema([table([{ name: 'a', type: 'String', comment: 'old' }])]);
        const [change] = diffSchema(withComment, actual);
        expect(change.kind).toBe('commentColumn');
        expect(change.sql).toBe("ALTER TABLE app.events COMMENT COLUMN a 'new';");
        expect(change.destructive).toBe(false);
    });

    it('reports nothing when the two already agree', () => {
        expect(diffSchema(intended, intended)).toEqual([]);
    });
});

describe('finding the key columns', () => {
    it('reads them out of ORDER BY and PRIMARY KEY', () => {
        const found = keyColumns(
            table([{ name: 'a', type: 'Date' }, { name: 'b', type: 'UInt64' }, { name: 'c', type: 'String' }], {
                engineOptions: { orderBy: '(a, b)', primaryKey: 'a' },
            })
        );
        expect([...found].sort()).toEqual(['a', 'b']);
    });

    it('does not match a column whose name is a prefix of a key column', () => {
        const found = keyColumns(
            table([{ name: 'user', type: 'String' }, { name: 'user_id', type: 'UInt64' }], {
                engineOptions: { orderBy: '(user_id)' },
            })
        );
        expect([...found]).toEqual(['user_id']);
    });

    it('finds nothing when the file does not say how the table is sorted', () => {
        expect(keyColumns(table([{ name: 'a', type: 'Date' }]))).toEqual(new Set());
    });
});

describe('diffing databases and tables', () => {
    it('creates a whole database the server does not have', () => {
        const changes = diffSchema(schema([table([{ name: 'a', type: 'Date' }])]), { databases: [] });
        expect(kinds(changes)).toEqual(['missingDatabase:app', 'createTable:events']);
        expect(changes[0].sql).toBe('CREATE DATABASE IF NOT EXISTS app;');
    });

    it('reports a table the file does not mention, but never drops it', () => {
        // A schema file describing part of a server is far more common than one
        // describing all of it.
        const changes = diffSchema(schema([]), schema([table([{ name: 'a', type: 'Date' }])]));
        expect(kinds(changes)).toEqual(['extraTable:events']);
        expect(changes[0].sql).toBeUndefined();
        expect(changes[0].destructive).toBe(true);
    });

    it('reports a database the file does not mention', () => {
        const changes = diffSchema({ databases: [] }, schema([], 'other'));
        expect(kinds(changes)).toEqual(['extraDatabase:other']);
    });

    it('is case-insensitive about names, as ClickHouse lookups tend to be', () => {
        const intended = schema([table([{ name: 'Event_Date', type: 'Date' }])], 'App');
        const actual = schema([table([{ name: 'event_date', type: 'Date' }], { name: 'EVENTS' })], 'app');
        expect(diffSchema(intended, actual)).toEqual([]);
    });
});

describe('the CREATE TABLE it generates', () => {
    it('is the statement a real server accepts', () => {
        expect(
            createTableSql(
                'app',
                table([{ name: 'event_date', type: 'Date' }, { name: 'user_id', type: 'UInt64' }], KEYED)
            )
        ).toBe(
            [
                'CREATE TABLE IF NOT EXISTS app.events',
                '(',
                '    event_date Date,',
                '    user_id UInt64',
                ')',
                'ENGINE = MergeTree',
                'PARTITION BY toYYYYMM(event_date)',
                'ORDER BY (event_date, user_id)',
                ';',
            ]
                .join('\n')
                .replace('\n;', ';')
        );
    });

    it('always writes an ORDER BY, because MergeTree requires one', () => {
        // tuple() is the honest default for a file that does not say.
        expect(createTableSql('app', table([{ name: 'a', type: 'Date' }]))).toContain('ORDER BY tuple()');
    });

    it('accepts snake_case engine options as well as camelCase', () => {
        const sql = createTableSql(
            'app',
            table([{ name: 'a', type: 'Date' }], { engineOptions: { order_by: 'a', partition_by: 'toYYYYMM(a)' } })
        );
        expect(sql).toContain('ORDER BY a');
        expect(sql).toContain('PARTITION BY toYYYYMM(a)');
    });
});

describe('rendering the migration', () => {
    const intended = schema([
        table([
            { name: 'event_date', type: 'Date' },
            { name: 'user_id', type: 'UInt64' },
            { name: 'payload', type: 'String' },
        ]),
    ]);
    const actual = schema([
        table([
            { name: 'event_date', type: 'Date' },
            { name: 'user_id', type: 'UInt64' },
            { name: 'legacy', type: 'String' },
        ]),
    ]);

    /** What running the rendered file would actually execute. */
    const runnable = (script: string) =>
        script
            .split('\n')
            .filter(line => line.trim() && !line.trim().startsWith('--'))
            .join('\n');

    it('runs only the safe changes; the rest are written but commented', () => {
        const script = renderMigration(diffSchema(intended, actual));
        expect(runnable(script)).toBe(
            'ALTER TABLE app.events ADD COLUMN IF NOT EXISTS payload String AFTER user_id;'
        );
        // The drop is still visible, so nothing is hidden from the reader.
        expect(script).toContain('-- ALTER TABLE app.events DROP COLUMN legacy;');
    });

    it('says plainly when there is nothing to do', () => {
        const script = renderMigration([]);
        expect(script).toContain('already matches');
        expect(runnable(script)).toBe('');
    });

    it('names the profile it was compared against', () => {
        expect(renderMigration([], { profile: 'prod' })).toContain('profile prod');
    });

    it('leaves a change with no statement as a note to decide by hand', () => {
        const script = renderMigration([
            { kind: 'extraTable', database: 'app', table: 'x', note: 'only on the server', destructive: true },
        ]);
        expect(script).toContain('only on the server');
        expect(script).toContain('decide it by hand');
        expect(runnable(script)).toBe('');
    });
});

describe('scaffolding', () => {
    const base = {
        database: 'app',
        table: 'events',
        columns: [
            { name: 'd', type: 'Date' },
            { name: 'uid', type: 'UInt64' },
            { name: 'kind', type: 'String' },
        ],
        orderBy: '(d, uid)',
        partitionBy: 'toYYYYMM(d)',
    };

    /** The statements only, without the explanatory header. */
    const statements = (sql: string) =>
        sql
            .split('\n')
            .filter(line => !line.trim().startsWith('--'))
            .join('\n');

    it('writes one plainly named table when there is no cluster', () => {
        // `events_local` with nothing in front of it is a name that explains a
        // distinction that does not exist.
        const sql = scaffold(base);
        expect(statements(sql)).toContain('CREATE TABLE IF NOT EXISTS app.events\n');
        expect(statements(sql)).not.toContain('events_local');
        expect(statements(sql)).not.toContain('Distributed');
        expect(sql).not.toContain('ON CLUSTER');
        expect(sql).toContain('Single node');
    });

    it('writes the local and Distributed pair for a cluster', () => {
        const sql = scaffold({ ...base, cluster: 'main', shardingKey: 'uid' });
        expect(sql).toContain('ON CLUSTER main');
        expect(sql).toContain('Distributed(main, app, events_local, uid)');
        // The Distributed table takes the plain name, so queries need no suffix.
        expect(sql).toContain('CREATE TABLE IF NOT EXISTS app.events ON CLUSTER main');
    });

    it('spreads writes rather than sending them all to one shard', () => {
        // A wrong sharding key is worse than a random one.
        expect(distributedTableSql({ ...base, cluster: 'main' })).toContain('rand()');
    });

    it('writes nothing distributed without a cluster', () => {
        expect(distributedTableSql(base)).toBeUndefined();
    });

    it('uses the macro form for a replicated engine, so every replica gets the same DDL', () => {
        const sql = localTableSql({ ...base, cluster: 'main', replicated: true });
        expect(sql).toContain("ReplicatedMergeTree('/clickhouse/tables/{shard}/app/events_local', '{replica}')");
    });

    it('writes the rollup table before the view that feeds it', () => {
        const sql = rollupSql({ ...base, rollup: { groupBy: ['d', 'kind'], aggregate: 'hits' } })!;
        expect(sql.indexOf('AggregatingMergeTree')).toBeLessThan(sql.indexOf('MATERIALIZED VIEW'));
        expect(sql).toContain('hits AggregateFunction(sum, UInt64)');
        expect(sql).toContain('sumState(toUInt64(1)) AS hits');
        // The view reads the table that holds the data, not a Distributed one.
        expect(sql).toContain('FROM app.events');
    });

    it('takes the grouped columns\' types from the table, not from a guess', () => {
        const sql = rollupSql({ ...base, rollup: { groupBy: ['d'], aggregate: 'hits' } })!;
        expect(sql).toContain('d Date');
    });

    it('writes no rollup when none was asked for', () => {
        expect(rollupSql(base)).toBeUndefined();
        expect(rollupSql({ ...base, rollup: { groupBy: [], aggregate: 'hits' } })).toBeUndefined();
    });

    it('orders the whole scaffold so it can be run top to bottom', () => {
        const sql = scaffold({
            ...base,
            cluster: 'main',
            rollup: { groupBy: ['d'], aggregate: 'hits' },
        });
        const body = statements(sql);
        expect(body.indexOf('events_local')).toBeLessThan(body.indexOf('Distributed'));
        expect(body.indexOf('Distributed')).toBeLessThan(body.indexOf('MATERIALIZED VIEW'));
    });
});

describe('reading a typed column list', () => {
    it('reads what people actually type', () => {
        expect(parseColumnList('a Date, b UInt64, c LowCardinality(String)')).toEqual([
            { name: 'a', type: 'Date' },
            { name: 'b', type: 'UInt64' },
            { name: 'c', type: 'LowCardinality(String)' },
        ]);
    });

    it('defaults a bare name to String rather than refusing it', () => {
        expect(parseColumnList('a, b UInt8')).toEqual([
            { name: 'a', type: 'String' },
            { name: 'b', type: 'UInt8' },
        ]);
    });

    it('ignores stray separators', () => {
        expect(parseColumnList('  a Date ,, ')).toEqual([{ name: 'a', type: 'Date' }]);
        expect(parseColumnList('')).toEqual([]);
    });
});
