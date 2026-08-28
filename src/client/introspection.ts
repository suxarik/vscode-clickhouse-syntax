/**
 * Reading a server's schema out of its own `system` tables.
 *
 * The result is shaped like the JSON schema file the extension already
 * understands, so completion, hover and diagnostics need no changes - they stop
 * caring where the schema came from.
 */
import { ClickHouseSchema, SchemaColumn, SchemaDatabase, SchemaTable } from '../types';
import { QueryResult } from './types';

/** The part of the client introspection needs, so tests can supply a fake. */
export interface QueryCapable {
    query(
        sql: string,
        options?: { readOnly?: boolean; maxRows?: number; maxExecutionTime?: number }
    ): Promise<QueryResult>;
}

export interface LiveSchema extends ClickHouseSchema {
    /** ClickHouse version the schema was read from. */
    serverVersion: string;
    /** Epoch milliseconds. */
    fetchedAt: number;
    profile: string;
}

export interface IntrospectOptions {
    /**
     * Include ClickHouse's own `system` database. Off by default: the bundled
     * catalog already describes it, and it is large.
     */
    includeSystem?: boolean;
    /** Stop rather than stall on a server with more tables than this. */
    maxTables?: number;
    maxExecutionTime?: number;
}

/** Databases that are never worth pulling. */
const ALWAYS_EXCLUDED = ['INFORMATION_SCHEMA', 'information_schema'];

function excludedList(options: IntrospectOptions): string {
    const excluded = [...ALWAYS_EXCLUDED];
    if (!options.includeSystem) excluded.push('system');
    return excluded.map(name => `'${name}'`).join(', ');
}

/** Look a column up by name, so the queries are not position-dependent. */
function indexer(result: QueryResult): (row: unknown[], name: string) => string {
    const positions = new Map(result.columns.map((column, index) => [column.name, index]));
    return (row, name) => {
        const position = positions.get(name);
        return position === undefined ? '' : String(row[position] ?? '');
    };
}

export async function introspect(
    client: QueryCapable,
    profile: string,
    options: IntrospectOptions = {}
): Promise<LiveSchema> {
    const excluded = excludedList(options);
    const maxTables = options.maxTables ?? 20000;
    const queryOptions = { readOnly: true, maxExecutionTime: options.maxExecutionTime ?? 30 };

    const versionResult = await client.query('SELECT version()', queryOptions);
    const serverVersion = String(versionResult.rows[0]?.[0] ?? '');

    const tableResult = await client.query(
        `SELECT database, name, engine, comment
         FROM system.tables
         WHERE database NOT IN (${excluded}) AND NOT is_temporary
         ORDER BY database, name`,
        { ...queryOptions, maxRows: maxTables }
    );

    const columnResult = await client.query(
        `SELECT database, table, name, type, default_expression, comment, compression_codec
         FROM system.columns
         WHERE database NOT IN (${excluded})
         ORDER BY database, table, position`,
        { ...queryOptions, maxRows: maxTables * 50 }
    );

    const tableField = indexer(tableResult);
    const columnField = indexer(columnResult);

    // Columns first, so each table can be assembled complete.
    const columnsByTable = new Map<string, SchemaColumn[]>();
    for (const row of columnResult.rows) {
        const key = `${columnField(row, 'database')}\u0000${columnField(row, 'table')}`;
        const column: SchemaColumn = {
            name: columnField(row, 'name'),
            type: columnField(row, 'type'),
        };
        const defaultExpression = columnField(row, 'default_expression');
        if (defaultExpression) column.defaultValue = defaultExpression;
        const comment = columnField(row, 'comment');
        if (comment) column.description = comment;
        const codec = columnField(row, 'compression_codec');
        if (codec) column.codec = codec;

        const existing = columnsByTable.get(key);
        if (existing) existing.push(column);
        else columnsByTable.set(key, [column]);
    }

    const databases = new Map<string, SchemaDatabase>();
    for (const row of tableResult.rows) {
        const databaseName = tableField(row, 'database');
        const tableName = tableField(row, 'name');
        const columns = columnsByTable.get(`${databaseName}\u0000${tableName}`) ?? [];
        // A table whose columns we cannot read is one the user cannot query.
        if (columns.length === 0) continue;

        const table: SchemaTable = { name: tableName, columns };
        const engine = tableField(row, 'engine');
        if (engine) table.engine = engine;
        const comment = tableField(row, 'comment');
        if (comment) table.description = comment;

        const database = databases.get(databaseName);
        if (database) database.tables.push(table);
        else databases.set(databaseName, { name: databaseName, tables: [table] });
    }

    return {
        version: '1.0',
        serverVersion,
        profile,
        fetchedAt: Date.now(),
        databases: [...databases.values()],
    };
}

/** Row counts and sizes for the explorer. Separate, because it is the slow query. */
export interface TableStatistics {
    database: string;
    table: string;
    rows: number;
    bytesOnDisk: number;
    uncompressedBytes: number;
    parts: number;
}

export async function tableStatistics(
    client: QueryCapable,
    options: IntrospectOptions = {}
): Promise<TableStatistics[]> {
    const excluded = excludedList(options);
    const result = await client.query(
        `SELECT database,
                table,
                sum(rows) AS rows,
                sum(bytes_on_disk) AS bytes_on_disk,
                sum(data_uncompressed_bytes) AS uncompressed,
                count() AS parts
         FROM system.parts
         WHERE active AND database NOT IN (${excluded})
         GROUP BY database, table`,
        { readOnly: true, maxExecutionTime: options.maxExecutionTime ?? 30 }
    );

    const field = indexer(result);
    return result.rows.map(row => ({
        database: field(row, 'database'),
        table: field(row, 'table'),
        // These arrive as strings: 64-bit values are quoted so they stay exact.
        rows: Number(field(row, 'rows')),
        bytesOnDisk: Number(field(row, 'bytes_on_disk')),
        uncompressedBytes: Number(field(row, 'uncompressed')),
        parts: Number(field(row, 'parts')),
    }));
}

export function countTables(schema: ClickHouseSchema): number {
    return schema.databases.reduce((total, database) => total + database.tables.length, 0);
}

export function countColumns(schema: ClickHouseSchema): number {
    return schema.databases.reduce(
        (total, database) => total + database.tables.reduce((sum, table) => sum + table.columns.length, 0),
        0
    );
}
