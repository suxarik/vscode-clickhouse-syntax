/**
 * What has to change for the server to match a schema file.
 *
 * The schema file is the intent; the server is the fact. This works out the
 * difference and writes it as `ALTER TABLE` statements you can read before
 * running any of them - which is the whole point. A migration tool that applies
 * silently is a migration tool nobody trusts with production.
 *
 * Free of `vscode`, so the interesting part is testable as what it is: two
 * descriptions in, a script out.
 */
import { ClickHouseSchema, SchemaColumn, SchemaTable } from '../types';

export type ChangeKind =
    | 'addColumn'
    | 'dropColumn'
    | 'modifyColumn'
    | 'rebuildRequired'
    | 'commentColumn'
    | 'createTable'
    | 'extraTable'
    | 'extraDatabase'
    | 'missingDatabase';

export interface Change {
    kind: ChangeKind;
    database: string;
    table?: string;
    column?: string;
    /** The SQL that would make this change, or undefined when none is safe. */
    sql?: string;
    /** Why this is here, in a sentence. */
    note: string;
    /** Whether applying this could lose data. */
    destructive: boolean;
}

/** Quote an identifier the way ClickHouse wants it. */
export function quoteIdentifier(name: string): string {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `\`${name.replace(/`/g, '\\`')}\``;
}

function quoteString(value: string): string {
    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

const qualified = (database: string, table: string) =>
    `${quoteIdentifier(database)}.${quoteIdentifier(table)}`;

/** The column clause as it appears in CREATE and ALTER. */
export function columnClause(column: SchemaColumn): string {
    const parts = [quoteIdentifier(column.name), column.type];
    if (column.defaultValue) parts.push(`DEFAULT ${column.defaultValue}`);
    if (column.codec) parts.push(`CODEC(${column.codec})`);
    if (column.ttl) parts.push(`TTL ${column.ttl}`);
    const comment = column.comment ?? column.description;
    if (comment) parts.push(`COMMENT ${quoteString(comment)}`);
    return parts.join(' ');
}

/** Types differ in a way worth a MODIFY, ignoring spacing. */
function typeChanged(intended: string, actual: string): boolean {
    const normalise = (type: string) => type.replace(/\s+/g, '').toLowerCase();
    return normalise(intended) !== normalise(actual);
}

function commentOf(column: SchemaColumn): string {
    return column.comment ?? column.description ?? '';
}

/**
 * Columns named in the sorting or primary key.
 *
 * Verified against a real server: ClickHouse refuses `MODIFY COLUMN` on one of
 * these with ALTER_OF_COLUMN_IS_FORBIDDEN, because the change would alter the
 * representation of the primary key. Emitting the statement anyway would
 * produce a script that stops halfway through.
 */
export function keyColumns(table: SchemaTable): Set<string> {
    const options = table.engineOptions ?? {};
    const expressions = [options.orderBy, options.order_by, options.primaryKey, options.primary_key]
        .filter((value): value is string => typeof value === 'string')
        .join(', ');
    const names = new Set<string>();
    for (const column of table.columns) {
        // Word-boundary match, so `user_id` does not match `user_id_hash`.
        if (new RegExp(`\\b${column.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(expressions)) {
            names.add(column.name.toLowerCase());
        }
    }
    return names;
}

/**
 * Compare one table.
 *
 * Column order is deliberately not compared: ClickHouse allows a position to be
 * set on ADD, but reordering an existing column means rewriting the table, and
 * no schema file is worth that.
 */
function diffTable(database: string, intended: SchemaTable, actual: SchemaTable): Change[] {
    const keys = keyColumns(intended);
    const changes: Change[] = [];
    const actualByName = new Map(actual.columns.map(column => [column.name.toLowerCase(), column]));
    const intendedByName = new Map(intended.columns.map(column => [column.name.toLowerCase(), column]));

    let previous: string | undefined;
    for (const column of intended.columns) {
        const existing = actualByName.get(column.name.toLowerCase());
        if (!existing) {
            // Placed after the column it follows in the file, so a new column
            // does not always land at the end.
            const after = previous ? ` AFTER ${quoteIdentifier(previous)}` : ' FIRST';
            changes.push({
                kind: 'addColumn',
                database,
                table: intended.name,
                column: column.name,
                sql: `ALTER TABLE ${qualified(database, intended.name)} ADD COLUMN IF NOT EXISTS ${columnClause(column)}${after};`,
                note: `'${column.name}' is in the schema file but not on the server.`,
                destructive: false,
            });
        } else if (typeChanged(column.type, existing.type) && keys.has(column.name.toLowerCase())) {
            // No SQL at all: the server rejects this, so offering a statement
            // would be offering one that cannot run.
            changes.push({
                kind: 'rebuildRequired',
                database,
                table: intended.name,
                column: column.name,
                note:
                    `'${column.name}' is ${existing.type} on the server and ${column.type} in the file, ` +
                    `and it is part of the sorting or primary key. ClickHouse refuses to ALTER a key ` +
                    `column's type. Create a new table with the intended shape, INSERT SELECT into it, ` +
                    `and rename.`,
                destructive: true,
            });
        } else if (typeChanged(column.type, existing.type)) {
            changes.push({
                kind: 'modifyColumn',
                database,
                table: intended.name,
                column: column.name,
                sql: `ALTER TABLE ${qualified(database, intended.name)} MODIFY COLUMN ${columnClause(column)};`,
                // A type change rewrites the column and can fail or truncate.
                note: `'${column.name}' is ${existing.type} on the server and ${column.type} in the file.`,
                destructive: true,
            });
        } else if (commentOf(column) && commentOf(column) !== commentOf(existing)) {
            changes.push({
                kind: 'commentColumn',
                database,
                table: intended.name,
                column: column.name,
                sql: `ALTER TABLE ${qualified(database, intended.name)} COMMENT COLUMN ${quoteIdentifier(column.name)} ${quoteString(commentOf(column))};`,
                note: `The comment on '${column.name}' differs.`,
                destructive: false,
            });
        }
        previous = column.name;
    }

    for (const column of actual.columns) {
        if (intendedByName.has(column.name.toLowerCase())) continue;
        changes.push({
            kind: 'dropColumn',
            database,
            table: intended.name,
            column: column.name,
            sql: `ALTER TABLE ${qualified(database, intended.name)} DROP COLUMN ${quoteIdentifier(column.name)};`,
            note: `'${column.name}' is on the server but not in the schema file. Dropping it deletes its data.`,
            destructive: true,
        });
    }

    return changes;
}

/** The full `CREATE TABLE` for a table the server does not have. */
export function createTableSql(database: string, table: SchemaTable): string {
    const columns = table.columns.map(column => `    ${columnClause(column)}`).join(',\n');
    const lines = [`CREATE TABLE IF NOT EXISTS ${qualified(database, table.name)}`, '(', columns, ')'];
    lines.push(`ENGINE = ${table.engine ?? 'MergeTree'}`);

    const options = table.engineOptions ?? {};
    const orderBy = options.orderBy ?? options.order_by;
    const partitionBy = options.partitionBy ?? options.partition_by;
    const primaryKey = options.primaryKey ?? options.primary_key;
    if (partitionBy) lines.push(`PARTITION BY ${String(partitionBy)}`);
    if (primaryKey) lines.push(`PRIMARY KEY ${String(primaryKey)}`);
    // ClickHouse requires ORDER BY on MergeTree; tuple() is the honest default
    // for a table the file does not say how to sort.
    lines.push(`ORDER BY ${String(orderBy ?? 'tuple()')}`);
    if (table.ttl) lines.push(`TTL ${table.ttl}`);
    if (table.description) lines.push(`COMMENT ${quoteString(table.description)}`);
    return `${lines.join('\n')};`;
}

/**
 * Every difference between a schema file and what the server has.
 *
 * The file is treated as the intent throughout: something present only on the
 * server is reported but never dropped by default, because a schema file that
 * describes part of a server is far more common than one that describes all
 * of it.
 */
export function diffSchema(intended: ClickHouseSchema, actual: ClickHouseSchema): Change[] {
    const changes: Change[] = [];
    const actualDatabases = new Map(actual.databases.map(database => [database.name.toLowerCase(), database]));
    const intendedDatabases = new Map(intended.databases.map(database => [database.name.toLowerCase(), database]));

    for (const database of intended.databases) {
        const live = actualDatabases.get(database.name.toLowerCase());
        if (!live) {
            changes.push({
                kind: 'missingDatabase',
                database: database.name,
                sql: `CREATE DATABASE IF NOT EXISTS ${quoteIdentifier(database.name)};`,
                note: `Database '${database.name}' is in the schema file but not on the server.`,
                destructive: false,
            });
            for (const table of database.tables) {
                changes.push({
                    kind: 'createTable',
                    database: database.name,
                    table: table.name,
                    sql: createTableSql(database.name, table),
                    note: `'${table.name}' is in the schema file but not on the server.`,
                    destructive: false,
                });
            }
            continue;
        }

        const liveTables = new Map(live.tables.map(table => [table.name.toLowerCase(), table]));
        for (const table of database.tables) {
            const existing = liveTables.get(table.name.toLowerCase());
            if (!existing) {
                changes.push({
                    kind: 'createTable',
                    database: database.name,
                    table: table.name,
                    sql: createTableSql(database.name, table),
                    note: `'${table.name}' is in the schema file but not on the server.`,
                    destructive: false,
                });
                continue;
            }
            changes.push(...diffTable(database.name, table, existing));
        }

        for (const table of live.tables) {
            if (database.tables.some(entry => entry.name.toLowerCase() === table.name.toLowerCase())) continue;
            changes.push({
                kind: 'extraTable',
                database: database.name,
                table: table.name,
                // No SQL: a table the file does not mention is usually a table
                // the file was never meant to cover.
                note: `'${table.name}' is on the server but not in the schema file.`,
                destructive: true,
            });
        }
    }

    for (const database of actual.databases) {
        if (intendedDatabases.has(database.name.toLowerCase())) continue;
        changes.push({
            kind: 'extraDatabase',
            database: database.name,
            note: `Database '${database.name}' is on the server but not in the schema file.`,
            destructive: true,
        });
    }

    return changes;
}

/**
 * Render the diff as a script.
 *
 * Destructive statements are written out but commented, so nothing that could
 * lose data runs because someone selected the whole file. Uncommenting is a
 * deliberate act, which is the correct amount of friction.
 */
export function renderMigration(changes: Change[], options: { profile?: string } = {}): string {
    const when = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const lines = [
        '-- Schema migration generated by ClickHouse SQL Syntax',
        `-- ${when}${options.profile ? ` · profile ${options.profile}` : ''}`,
        '--',
        '-- The schema file is treated as the intent and the server as the fact.',
        '-- Read this before running any of it.',
        '',
    ];

    if (changes.length === 0) {
        lines.push('-- The server already matches the schema file. Nothing to do.');
        return `${lines.join('\n')}\n`;
    }

    const safe = changes.filter(change => !change.destructive && change.sql);
    const risky = changes.filter(change => change.destructive || !change.sql);

    if (safe.length > 0) {
        lines.push(`-- ${safe.length} safe change${safe.length === 1 ? '' : 's'}`, '');
        for (const change of safe) {
            lines.push(`-- ${change.note}`, change.sql!, '');
        }
    }

    if (risky.length > 0) {
        lines.push(
            '-- ─────────────────────────────────────────────────────────────',
            `-- ${risky.length} change${risky.length === 1 ? '' : 's'} that could lose data, left commented out.`,
            '-- Uncomment only what you mean to run.',
            ''
        );
        for (const change of risky) {
            lines.push(`-- ${change.note}`);
            if (change.sql) {
                for (const line of change.sql.split('\n')) lines.push(`-- ${line}`);
            } else {
                lines.push('-- No statement is generated for this; decide it by hand.');
            }
            lines.push('');
        }
    }

    return `${lines.join('\n')}\n`;
}
