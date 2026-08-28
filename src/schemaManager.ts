/**
 * Schema loading, validation and lookup for ClickHouse IntelliSense.
 *
 * Every file matched by `clickhouse.schema.paths` is merged, so a workspace can
 * split its schema per database. Lookups go through prebuilt indexes rather than
 * scanning the whole schema on every keystroke.
 */
import * as vscode from 'vscode';
import { ClickHouseSchema, SchemaTable, SchemaColumn } from './types';

export interface SchemaValidationIssue {
    file?: string;
    path: string;
    message: string;
}

export interface SchemaLoadResult {
    schema: ClickHouseSchema | null;
    files: string[];
    issues: SchemaValidationIssue[];
}

interface TableEntry {
    db: string;
    table: SchemaTable;
}

export class SchemaManager implements vscode.Disposable {
    private schema: ClickHouseSchema | null = null;
    private issues: SchemaValidationIssue[] = [];
    private loadedFiles: string[] = [];
    private disposables: vscode.Disposable[] = [];

    /** `table` and `db.table`, both lower-cased. */
    private tableIndex = new Map<string, TableEntry[]>();
    private columnIndex = new Map<string, Array<{ db: string; table: string; column: SchemaColumn }>>();
    private loading: Promise<void> | null = null;

    constructor(private context: vscode.ExtensionContext) {
        void this.loadSchema();
        this.setupWatcher();
    }

    private schemaPaths(): string[] {
        const configured = vscode.workspace
            .getConfiguration('clickhouse')
            .get<string | string[]>('schema.paths', ['./clickhouse-schema.json']);
        const list = Array.isArray(configured) ? configured : [configured];
        return list.filter(p => typeof p === 'string' && p.trim().length > 0).map(normalizeGlob);
    }

    private setupWatcher(): void {
        const autoRefresh = vscode.workspace.getConfiguration('clickhouse').get<boolean>('schema.autoRefresh', true);
        if (autoRefresh) {
            for (const pattern of this.schemaPaths()) {
                const watcher = vscode.workspace.createFileSystemWatcher(pattern);
                this.disposables.push(
                    watcher.onDidChange(() => void this.loadSchema()),
                    watcher.onDidCreate(() => void this.loadSchema()),
                    watcher.onDidDelete(() => void this.loadSchema()),
                    watcher
                );
            }
        }

        this.disposables.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('clickhouse.schema')) {
                    this.reset();
                    void this.loadSchema();
                }
            })
        );
    }

    private reset(): void {
        for (const d of this.disposables) d.dispose();
        this.disposables = [];
        this.setupWatcher();
    }

    async loadSchema(): Promise<SchemaLoadResult> {
        // Collapse concurrent reloads (a watcher burst on save is common).
        if (this.loading) await this.loading;
        let done!: () => void;
        this.loading = new Promise<void>(resolve => (done = resolve));
        try {
            return await this.doLoadSchema();
        } finally {
            done();
            this.loading = null;
        }
    }

    private async doLoadSchema(): Promise<SchemaLoadResult> {
        const config = vscode.workspace.getConfiguration('clickhouse');
        if (!config.get<boolean>('schema.enabled', true)) {
            this.setSchema(null, [], []);
            return { schema: null, files: [], issues: [] };
        }

        const merged: ClickHouseSchema = { version: '1.0', databases: [] };
        const issues: SchemaValidationIssue[] = [];
        const files: string[] = [];
        const seen = new Set<string>();

        for (const pattern of this.schemaPaths()) {
            let matches: vscode.Uri[] = [];
            try {
                matches = await vscode.workspace.findFiles(pattern, '**/node_modules/**');
            } catch (err) {
                issues.push({ path: pattern, message: `Could not search for schema files: ${describe(err)}` });
                continue;
            }

            for (const uri of matches) {
                if (seen.has(uri.toString())) continue;
                seen.add(uri.toString());

                let parsed: unknown;
                try {
                    const content = await vscode.workspace.fs.readFile(uri);
                    parsed = JSON.parse(Buffer.from(content).toString('utf8'));
                } catch (err) {
                    issues.push({ file: uri.fsPath, path: '', message: `Could not read or parse: ${describe(err)}` });
                    continue;
                }

                const fileIssues = validateSchema(parsed);
                if (fileIssues.length > 0) {
                    issues.push(...fileIssues.map(issue => ({ ...issue, file: uri.fsPath })));
                    continue;
                }

                files.push(uri.fsPath);
                mergeInto(merged, parsed as ClickHouseSchema, uri.fsPath, issues);
            }
        }

        const schema = merged.databases.length > 0 ? merged : null;
        this.setSchema(schema, files, issues);
        return { schema, files, issues };
    }

    private setSchema(schema: ClickHouseSchema | null, files: string[], issues: SchemaValidationIssue[]): void {
        this.schema = schema;
        this.loadedFiles = files;
        this.issues = issues;
        this.rebuildIndexes();
    }

    private rebuildIndexes(): void {
        this.tableIndex = new Map();
        this.columnIndex = new Map();
        if (!this.schema) return;

        for (const db of this.schema.databases) {
            for (const table of db.tables) {
                for (const key of [table.name.toLowerCase(), `${db.name}.${table.name}`.toLowerCase()]) {
                    const list = this.tableIndex.get(key) ?? [];
                    list.push({ db: db.name, table });
                    this.tableIndex.set(key, list);
                }
                for (const column of table.columns) {
                    const key = column.name.toLowerCase();
                    const list = this.columnIndex.get(key) ?? [];
                    list.push({ db: db.name, table: table.name, column });
                    this.columnIndex.set(key, list);
                }
            }
        }
    }

    getSchema(): ClickHouseSchema | null {
        return this.schema;
    }

    getIssues(): SchemaValidationIssue[] {
        return this.issues;
    }

    getLoadedFiles(): string[] {
        return this.loadedFiles;
    }

    getDatabases(): string[] {
        return this.schema?.databases.map(d => d.name) ?? [];
    }

    getTables(database?: string): Array<{ db: string; table: SchemaTable }> {
        const result: Array<{ db: string; table: SchemaTable }> = [];
        if (!this.schema) return result;
        for (const db of this.schema.databases) {
            if (database && db.name.toLowerCase() !== database.toLowerCase()) continue;
            for (const table of db.tables) result.push({ db: db.name, table });
        }
        return result;
    }

    findTable(name: string, database?: string): { db: string; table: SchemaTable } | undefined {
        if (!name) return undefined;
        const key = database ? `${database}.${name}`.toLowerCase() : name.toLowerCase();
        return this.tableIndex.get(key)?.[0];
    }

    findColumn(tableName: string, columnName: string, database?: string): SchemaColumn | undefined {
        const found = this.findTable(tableName, database);
        if (!found) return undefined;
        return found.table.columns.find(c => c.name.toLowerCase() === columnName.toLowerCase());
    }

    findColumnsByName(columnName: string): Array<{ db: string; table: string; column: SchemaColumn }> {
        return this.columnIndex.get(columnName.toLowerCase()) ?? [];
    }

    getAllColumns(): Array<{ db: string; table: string; column: SchemaColumn }> {
        const result: Array<{ db: string; table: string; column: SchemaColumn }> = [];
        for (const list of this.columnIndex.values()) result.push(...list);
        return result;
    }

    getEngine(tableName: string, database?: string): string | undefined {
        return this.findTable(tableName, database)?.table.engine;
    }

    dispose(): void {
        for (const d of this.disposables) d.dispose();
        this.disposables = [];
    }
}

/** `./x.json` and `x.json` are workspace-relative; VS Code globs must not lead with `./`. */
function normalizeGlob(pattern: string): string {
    return pattern.replace(/^\.\//, '');
}

function describe(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** Structural validation. An empty result means the document is usable. */
export function validateSchema(schema: unknown): SchemaValidationIssue[] {
    const issues: SchemaValidationIssue[] = [];
    if (!schema || typeof schema !== 'object') {
        return [{ path: '', message: 'Schema must be a JSON object' }];
    }
    const root = schema as Record<string, unknown>;
    if (!Array.isArray(root.databases)) {
        return [{ path: 'databases', message: 'Missing "databases" array' }];
    }

    root.databases.forEach((db: unknown, dbIndex: number) => {
        const dbPath = `databases[${dbIndex}]`;
        if (!db || typeof db !== 'object') {
            issues.push({ path: dbPath, message: 'Database entry must be an object' });
            return;
        }
        const database = db as Record<string, unknown>;
        if (typeof database.name !== 'string' || !database.name) {
            issues.push({ path: `${dbPath}.name`, message: 'Database requires a non-empty "name"' });
        }
        if (!Array.isArray(database.tables)) {
            issues.push({ path: `${dbPath}.tables`, message: 'Database requires a "tables" array' });
            return;
        }
        database.tables.forEach((tbl: unknown, tableIndex: number) => {
            const tablePath = `${dbPath}.tables[${tableIndex}]`;
            if (!tbl || typeof tbl !== 'object') {
                issues.push({ path: tablePath, message: 'Table entry must be an object' });
                return;
            }
            const table = tbl as Record<string, unknown>;
            if (typeof table.name !== 'string' || !table.name) {
                issues.push({ path: `${tablePath}.name`, message: 'Table requires a non-empty "name"' });
            }
            if (!Array.isArray(table.columns)) {
                issues.push({ path: `${tablePath}.columns`, message: 'Table requires a "columns" array' });
                return;
            }
            table.columns.forEach((col: unknown, columnIndex: number) => {
                const columnPath = `${tablePath}.columns[${columnIndex}]`;
                if (!col || typeof col !== 'object') {
                    issues.push({ path: columnPath, message: 'Column entry must be an object' });
                    return;
                }
                const column = col as Record<string, unknown>;
                if (typeof column.name !== 'string' || !column.name) {
                    issues.push({ path: `${columnPath}.name`, message: 'Column requires a non-empty "name"' });
                }
                if (typeof column.type !== 'string' || !column.type) {
                    issues.push({ path: `${columnPath}.type`, message: 'Column requires a non-empty "type"' });
                }
            });
        });
    });

    return issues;
}

/** Merge one schema document into the accumulator, reporting collisions. */
function mergeInto(
    target: ClickHouseSchema,
    source: ClickHouseSchema,
    file: string,
    issues: SchemaValidationIssue[]
): void {
    for (const db of source.databases) {
        const existing = target.databases.find(d => d.name.toLowerCase() === db.name.toLowerCase());
        if (!existing) {
            target.databases.push({ ...db, tables: [...db.tables] });
            continue;
        }
        for (const table of db.tables) {
            const clash = existing.tables.find(t => t.name.toLowerCase() === table.name.toLowerCase());
            if (clash) {
                issues.push({
                    file,
                    path: `${db.name}.${table.name}`,
                    message: `Duplicate table definition; the first definition loaded is kept`,
                });
                continue;
            }
            existing.tables.push(table);
        }
    }
}
