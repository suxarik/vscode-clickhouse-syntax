/**
 * Shared test fixtures.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { SchemaManager } from '../schemaManager';
import { Catalog } from '../catalog';
import { ClickHouseSchema } from '../types';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * A Catalog reading its assets from the real `catalog/` directory.
 *
 * The `vscode.workspace.fs.readFile` mock is pointed at the filesystem for
 * catalog paths, so the tests exercise the same loading path as the extension.
 */
export function makeCatalog(): Catalog {
    installFsMock();
    return new Catalog(vscode.Uri.file(REPO_ROOT));
}

let sampleSchemaJson: string | null = JSON.stringify({ databases: [] });

/** Route catalog reads to disk and schema reads to the in-memory fixture. */
function installFsMock(): void {
    const readFile = vscode.workspace.fs.readFile as unknown as jest.Mock;
    readFile.mockImplementation(async (uri: vscode.Uri) => {
        const filePath = uri.fsPath ?? String(uri);
        if (filePath.includes(`${path.sep}catalog${path.sep}`) || filePath.includes('/catalog/')) {
            return fs.readFileSync(path.join(REPO_ROOT, 'catalog', path.basename(filePath)));
        }
        if (sampleSchemaJson === null) throw new Error('no schema file');
        return Buffer.from(sampleSchemaJson, 'utf8');
    });
}

export const SAMPLE_SCHEMA: ClickHouseSchema = {
    version: '1.0',
    databases: [
        {
            name: 'analytics',
            tables: [
                {
                    name: 'events',
                    engine: 'MergeTree',
                    description: 'Raw events',
                    columns: [
                        { name: 'event_id', type: 'UInt64', description: 'Unique id' },
                        { name: 'event_time', type: 'DateTime' },
                        { name: 'user_id', type: 'UInt64' },
                    ],
                },
                {
                    name: 'users',
                    engine: 'ReplacingMergeTree',
                    columns: [
                        { name: 'user_id', type: 'UInt64' },
                        { name: 'name', type: 'String' },
                    ],
                },
            ],
        },
    ],
};

/** A SchemaManager loaded from an in-memory schema document. */
export async function makeSchemaManager(schema: ClickHouseSchema | null = SAMPLE_SCHEMA): Promise<SchemaManager> {
    const w = vscode.workspace as unknown as { findFiles: jest.Mock };
    if (schema) {
        w.findFiles.mockResolvedValue([vscode.Uri.file('/test/clickhouse-schema.json')]);
        sampleSchemaJson = JSON.stringify(schema);
    } else {
        w.findFiles.mockResolvedValue([]);
        sampleSchemaJson = null;
    }
    installFsMock();

    const context = {
        subscriptions: [],
        workspaceState: {
            get: jest.fn((_key: string, fallback: unknown) => fallback),
            update: jest.fn(async () => undefined),
        },
    } as unknown as vscode.ExtensionContext;

    const manager = new SchemaManager(context);
    await manager.loadSchema();
    return manager;
}

/** Config object shaped like `workspace.getConfiguration('clickhouse')`. */
export function makeConfig(overrides: Record<string, unknown> = {}): vscode.WorkspaceConfiguration {
    return {
        get: (key: string, fallback?: unknown) =>
            Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : fallback,
    } as unknown as vscode.WorkspaceConfiguration;
}

/** Document plus the offset of a `|` cursor marker. */
export function docAt(sql: string, languageId = 'clickhouse') {
    const offset = sql.indexOf('|');
    const text = offset >= 0 ? sql.replace('|', '') : sql;
    const document = new (vscode as unknown as { TextDocument: new (t: string, l?: string) => vscode.TextDocument })
        .TextDocument(text, languageId);
    return { document, offset: offset < 0 ? 0 : offset, position: document.positionAt(offset < 0 ? 0 : offset) };
}

/** Raw edits recorded by the mock WorkspaceEdit. */
export function editsOf(edit: vscode.WorkspaceEdit | undefined): Array<{ newText: string }> {
    if (!edit) return [];
    return (edit as unknown as { edits: Array<{ newText: string }> }).edits;
}
