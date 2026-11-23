/**
 * Reading every table's definition once, which is all the graph needs.
 */
import { QueryResult } from '../client/types';
import { LineageGraph, TableRow, buildGraph } from './graph';

export interface LineageClient {
    query(sql: string, options?: { readOnly?: boolean; maxExecutionTime?: number }): Promise<QueryResult>;
}

const SQL =
    'SELECT database, name, engine, engine_full, ' +
    // The definition is only read for the engines that have something to say,
    // so a server with thousands of plain tables does not ship all their DDL.
    "if(engine = 'MaterializedView', create_table_query, '') AS create_query, " +
    'toString(uuid) AS uuid, dependencies_database, dependencies_table ' +
    "FROM system.tables WHERE database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema') " +
    'ORDER BY database, name LIMIT 50000';

const list = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);

export function toRows(result: QueryResult): TableRow[] {
    return result.rows.map(row => {
        const o: Record<string, unknown> = {};
        result.columns.forEach((column, index) => (o[column.name] = row[index]));
        const databases = list(o.dependencies_database);
        const tables = list(o.dependencies_table);
        return {
            database: String(o.database ?? ''),
            name: String(o.name ?? ''),
            engine: String(o.engine ?? ''),
            engineFull: String(o.engine_full ?? ''),
            createQuery: String(o.create_query ?? ''),
            uuid: String(o.uuid ?? ''),
            dependents: tables.map((table, index) => ({ database: databases[index] ?? '', table })),
        };
    });
}

export async function fetchLineage(client: LineageClient): Promise<LineageGraph> {
    const result = await client.query(SQL, { readOnly: true, maxExecutionTime: 30 });
    return buildGraph(toRows(result));
}
