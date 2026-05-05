/**
 * Schema loading, validation, and management for ClickHouse IntelliSense.
 */
import * as vscode from 'vscode';
import { ClickHouseSchema, SchemaTable, SchemaColumn } from './types';

export class SchemaManager implements vscode.Disposable {
    private schema: ClickHouseSchema | null = null;
    private disposables: vscode.Disposable[] = [];

    constructor(private context: vscode.ExtensionContext) {
        this.loadSchema();
        this.setupWatcher();
    }

    private setupWatcher(): void {
        const config = vscode.workspace.getConfiguration('clickhouse');
        const schemaPaths = config.get<string[]>('schema.paths', ['./clickhouse-schema.json']);

        for (const pattern of schemaPaths) {
            const watcher = vscode.workspace.createFileSystemWatcher(pattern);
            this.disposables.push(
                watcher.onDidChange(() => this.loadSchema()),
                watcher.onDidCreate(() => this.loadSchema()),
                watcher.onDidDelete(() => this.loadSchema()),
                watcher
            );
        }

        this.disposables.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('clickhouse.schema')) {
                    this.loadSchema();
                }
            })
        );
    }

    public async loadSchema(): Promise<void> {
        const config = vscode.workspace.getConfiguration('clickhouse');
        const enabled = config.get<boolean>('schema.enabled', true);
        if (!enabled) {
            this.schema = null;
            return;
        }

        const schemaPaths = config.get<string[]>('schema.paths', ['./clickhouse-schema.json']);

        for (const pattern of schemaPaths) {
            try {
                const files = await vscode.workspace.findFiles(pattern);
                if (files.length > 0) {
                    const content = await vscode.workspace.fs.readFile(files[0]);
                    const parsed = JSON.parse(content.toString());
                    if (this.validateSchema(parsed)) {
                        this.schema = parsed;
                        return;
                    }
                }
            } catch (err) {
                console.error(`Failed to load schema from ${pattern}:`, err);
            }
        }

        this.schema = null;
    }

    private validateSchema(schema: any): boolean {
        if (!schema || !Array.isArray(schema.databases)) return false;
        for (const db of schema.databases) {
            if (!db.name || !Array.isArray(db.tables)) return false;
            for (const table of db.tables) {
                if (!table.name || !Array.isArray(table.columns)) return false;
                for (const col of table.columns) {
                    if (!col.name || !col.type) return false;
                }
            }
        }
        return true;
    }

    public getSchema(): ClickHouseSchema | null {
        return this.schema;
    }

    public getDatabases(): string[] {
        return this.schema?.databases.map(d => d.name) || [];
    }

    public getTables(database?: string): Array<{ db: string; table: SchemaTable }> {
        const result: Array<{ db: string; table: SchemaTable }> = [];
        if (!this.schema) return result;
        for (const db of this.schema.databases) {
            if (!database || db.name === database) {
                for (const table of db.tables) {
                    result.push({ db: db.name, table });
                }
            }
        }
        return result;
    }

    public findTable(name: string): { db: string; table: SchemaTable } | undefined {
        if (!this.schema) return undefined;
        for (const db of this.schema.databases) {
            for (const table of db.tables) {
                if (table.name === name) return { db: db.name, table };
            }
        }
        return undefined;
    }

    public findColumn(tableName: string, columnName: string): SchemaColumn | undefined {
        const found = this.findTable(tableName);
        return found?.table.columns.find(c => c.name === columnName);
    }

    public getAllColumns(): Array<{ db: string; table: string; column: SchemaColumn }> {
        const result: Array<{ db: string; table: string; column: SchemaColumn }> = [];
        if (!this.schema) return result;
        for (const db of this.schema.databases) {
            for (const table of db.tables) {
                for (const column of table.columns) {
                    result.push({ db: db.name, table: table.name, column });
                }
            }
        }
        return result;
    }

    public getEngine(tableName: string): string | undefined {
        return this.findTable(tableName)?.table.engine;
    }

    public dispose(): void {
        for (const d of this.disposables) d.dispose();
        this.disposables = [];
    }
}
