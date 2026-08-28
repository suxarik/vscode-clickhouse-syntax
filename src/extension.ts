/**
 * ClickHouse SQL extension for VS Code.
 * Thin orchestrator: registers providers, commands and listeners.
 */
import * as vscode from 'vscode';
import { SchemaManager } from './schemaManager';
import { formatSQLWithOptions } from './sqlFormatter';
import { KeywordCase } from './keywords';
import { LanguageDetector } from './languageDetection';
import { registerHoverProvider } from './providers/hoverProvider';
import { registerCompletionProvider } from './providers/completionProvider';
import { registerSignatureHelpProvider } from './providers/signatureHelpProvider';
import { createDiagnosticCollection, DiagnosticManager } from './providers/diagnosticProvider';
import { registerCodeActionProvider } from './providers/codeActionProvider';
import { Catalog, CATALOG_VERSION, CATALOG_GENERATED_AT, CATALOG_COUNTS } from './catalog';

const SUPPORTED_LANGUAGES = ['clickhouse', 'sql'];

function isSupported(document: vscode.TextDocument): boolean {
    return SUPPORTED_LANGUAGES.includes(document.languageId);
}

function formatOptions(): { keywordCase: KeywordCase; indentSize: number } {
    const config = vscode.workspace.getConfiguration('clickhouse');
    const keywordCase = config.get<string>('format.keywordCase', 'upper');
    return {
        keywordCase: keywordCase === 'lower' ? 'lower' : keywordCase === 'preserve' ? 'preserve' : 'upper',
        indentSize: config.get<number>('format.indentSize', 4),
    };
}

/**
 * Which languages the formatter registers for. Registering for `sql`
 * unconditionally would make this extension a candidate default formatter for
 * every Postgres/MySQL file in the workspace, so that is opt-in.
 */
function formatterSelector(): vscode.DocumentSelector {
    const registerForSql = vscode.workspace
        .getConfiguration('clickhouse')
        .get<boolean>('format.registerForSqlLanguage', false);
    return registerForSql ? [{ language: 'clickhouse' }, { language: 'sql' }] : [{ language: 'clickhouse' }];
}

export function activate(context: vscode.ExtensionContext) {
    const catalog = new Catalog(context.extensionUri);
    const schemaManager = new SchemaManager(context);
    const detector = new LanguageDetector(context);
    context.subscriptions.push(schemaManager, detector);

    const diagnosticCollection = createDiagnosticCollection();
    const diagnostics = new DiagnosticManager(diagnosticCollection, schemaManager, catalog);
    context.subscriptions.push(diagnosticCollection, diagnostics);

    // ── Formatting providers, re-registered when the setting changes ──
    let formatterDisposables: vscode.Disposable[] = [];
    const registerFormatters = () => {
        for (const d of formatterDisposables) d.dispose();
        const selector = formatterSelector();
        formatterDisposables = [
            vscode.languages.registerDocumentFormattingEditProvider(selector, {
                provideDocumentFormattingEdits(document) {
                    return formatWholeDocument(document);
                },
            }),
            vscode.languages.registerDocumentRangeFormattingEditProvider(selector, {
                provideDocumentRangeFormattingEdits(document, range) {
                    return formatRange(document, range);
                },
            }),
        ];
    };
    registerFormatters();
    context.subscriptions.push(
        new vscode.Disposable(() => {
            for (const d of formatterDisposables) d.dispose();
        }),
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('clickhouse.format.registerForSqlLanguage')) registerFormatters();
            if (e.affectsConfiguration('clickhouse.diagnostics')) {
                for (const document of vscode.workspace.textDocuments) {
                    if (isSupported(document)) diagnostics.run(document);
                }
            }
        })
    );

    // ── Language detection ──
    for (const document of vscode.workspace.textDocuments) void detector.consider(document);
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(document => void detector.consider(document)),
        vscode.workspace.onDidSaveTextDocument(document => void detector.consider(document))
    );

    // ── Diagnostics ──
    for (const document of vscode.workspace.textDocuments) {
        if (isSupported(document)) diagnostics.run(document);
    }
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(e => {
            if (isSupported(e.document)) diagnostics.schedule(e.document);
        }),
        vscode.workspace.onDidOpenTextDocument(document => {
            if (isSupported(document)) diagnostics.run(document);
        }),
        vscode.workspace.onDidCloseTextDocument(document => diagnostics.clear(document))
    );

    // ── IntelliSense providers ──
    context.subscriptions.push(
        registerHoverProvider(schemaManager, catalog),
        registerCompletionProvider(schemaManager, catalog),
        registerSignatureHelpProvider(catalog),
        registerCodeActionProvider(schemaManager)
    );

    // Warm the catalog assets in the background so the first hover is not the
    // one that pays for reading them.
    setTimeout(() => catalog.preload(), 2000);

    // ── Commands ──
    context.subscriptions.push(
        vscode.commands.registerCommand('clickhouse.detectLanguage', () => detector.detectExplicitly()),
        vscode.commands.registerCommand('clickhouse.toggleLanguage', () => detector.toggleLanguage()),

        vscode.commands.registerCommand('clickhouse.reloadSchema', async () => {
            const result = await schemaManager.loadSchema();
            if (result.schema) {
                const tables = result.schema.databases.reduce((n, db) => n + db.tables.length, 0);
                vscode.window.showInformationMessage(
                    `ClickHouse: loaded ${tables} table(s) from ${result.files.length} schema file(s).`
                );
            } else if (result.issues.length > 0) {
                vscode.window.showWarningMessage(
                    `ClickHouse: schema could not be loaded (${result.issues.length} issue(s)). Run "ClickHouse: Validate Schema" for details.`
                );
            } else {
                vscode.window.showInformationMessage('ClickHouse: no schema file found.');
            }
            for (const document of vscode.workspace.textDocuments) {
                if (isSupported(document)) diagnostics.run(document);
            }
        }),

        vscode.commands.registerCommand('clickhouse.validateSchema', async () => {
            const result = await schemaManager.loadSchema();
            if (result.issues.length === 0) {
                if (!result.schema) {
                    vscode.window.showInformationMessage(
                        'ClickHouse: no schema file found. Run "ClickHouse: Generate Schema Template" to create one.'
                    );
                    return;
                }
                const tables = result.schema.databases.reduce((n, db) => n + db.tables.length, 0);
                const columns = result.schema.databases.reduce(
                    (n, db) => n + db.tables.reduce((m, t) => m + t.columns.length, 0),
                    0
                );
                vscode.window.showInformationMessage(
                    `ClickHouse: schema is valid — ${result.schema.databases.length} database(s), ${tables} table(s), ${columns} column(s).`
                );
                return;
            }

            const channel = vscode.window.createOutputChannel('ClickHouse Schema');
            channel.clear();
            channel.appendLine(`Schema validation found ${result.issues.length} issue(s):`);
            for (const issue of result.issues) {
                const where = [issue.file, issue.path].filter(Boolean).join(' → ');
                channel.appendLine(`  • ${where ? `${where}: ` : ''}${issue.message}`);
            }
            channel.show(true);
            vscode.window.showWarningMessage(`ClickHouse: schema has ${result.issues.length} issue(s). See output.`);
        }),

        vscode.commands.registerCommand('clickhouse.generateSchemaTemplate', async () => {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                vscode.window.showWarningMessage('ClickHouse: open a folder before generating a schema template.');
                return;
            }
            const uri = vscode.Uri.joinPath(workspaceFolder.uri, 'clickhouse-schema.json');
            try {
                await vscode.workspace.fs.stat(uri);
                const choice = await vscode.window.showWarningMessage(
                    `${uri.fsPath} already exists. Overwrite it?`,
                    'Overwrite'
                );
                if (choice !== 'Overwrite') return;
            } catch {
                // Does not exist yet — nothing to confirm.
            }

            await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(SCHEMA_TEMPLATE, null, 2), 'utf8'));
            await schemaManager.loadSchema();
            const document = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(document);
            vscode.window.showInformationMessage(`ClickHouse: schema template created at ${uri.fsPath}`);
        }),

        vscode.commands.registerCommand('clickhouse.showCatalogInfo', async () => {
            const configured = vscode.workspace.getConfiguration('clickhouse').get<string>('serverVersion', 'auto');
            const lines = [
                `Catalog generated from ClickHouse ${CATALOG_VERSION} on ${CATALOG_GENERATED_AT}.`,
                '',
                `  functions       ${CATALOG_COUNTS.functions} (${CATALOG_COUNTS.documentedFunctions} documented)`,
                `  data types      ${CATALOG_COUNTS.dataTypes}`,
                `  table engines   ${CATALOG_COUNTS.engines}`,
                `  settings        ${CATALOG_COUNTS.settings}`,
                `  formats         ${CATALOG_COUNTS.formats}`,
                `  keywords        ${CATALOG_COUNTS.keywords}`,
                `  system tables   ${CATALOG_COUNTS.systemTables}`,
                '',
                configured === 'auto'
                    ? 'clickhouse.serverVersion is "auto": completions are not filtered by server version.'
                    : `clickhouse.serverVersion is ${configured}: functions newer than that are hidden.`,
            ];
            const channel = vscode.window.createOutputChannel('ClickHouse Catalog');
            channel.clear();
            for (const line of lines) channel.appendLine(line);
            channel.show(true);
        }),

        vscode.commands.registerCommand('clickhouse.formatDocument', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('ClickHouse: no active editor.');
                return;
            }
            const document = editor.document;
            const selection = editor.selection;
            const edits = selection.isEmpty ? formatWholeDocument(document) : formatRange(document, selection);
            if (edits.length === 0) {
                vscode.window.showInformationMessage('ClickHouse: document is already formatted.');
                return;
            }
            await editor.edit(builder => {
                for (const edit of edits) builder.replace(edit.range, edit.newText);
            });
        })
    );
}

function formatWholeDocument(document: vscode.TextDocument): vscode.TextEdit[] {
    const config = vscode.workspace.getConfiguration('clickhouse');
    if (!config.get<boolean>('format.enabled', true)) return [];

    const text = document.getText();
    let formatted: string;
    try {
        formatted = formatSQLWithOptions(text, formatOptions());
    } catch (err) {
        console.error('ClickHouse: formatting failed', err);
        return [];
    }
    if (formatted === text) return [];

    const range = new vscode.Range(document.positionAt(0), document.positionAt(text.length));
    return [vscode.TextEdit.replace(range, formatted)];
}

function formatRange(document: vscode.TextDocument, range: vscode.Range): vscode.TextEdit[] {
    const config = vscode.workspace.getConfiguration('clickhouse');
    if (!config.get<boolean>('format.enabled', true)) return [];

    const text = document.getText(range);
    let formatted: string;
    try {
        formatted = formatSQLWithOptions(text, formatOptions());
    } catch (err) {
        console.error('ClickHouse: formatting failed', err);
        return [];
    }
    if (formatted === text) return [];
    return [vscode.TextEdit.replace(range, formatted)];
}

const SCHEMA_TEMPLATE = {
    version: '1.0',
    databases: [
        {
            name: 'example_db',
            description: 'Example database',
            tables: [
                {
                    name: 'events',
                    description: 'Example events table',
                    engine: 'MergeTree',
                    engineOptions: {
                        orderBy: ['event_date', 'event_id'],
                        partitionBy: 'toYYYYMM(event_date)',
                    },
                    columns: [
                        { name: 'event_id', type: 'UInt64', description: 'Unique event identifier' },
                        { name: 'event_date', type: 'Date', description: 'Partitioning date' },
                        { name: 'event_time', type: 'DateTime', description: 'Event timestamp' },
                        { name: 'user_id', type: 'UInt64', description: 'User identifier' },
                        { name: 'event_type', type: 'LowCardinality(String)', description: 'Event type' },
                    ],
                },
            ],
        },
    ],
};

export function deactivate() {
    // Everything is registered through context.subscriptions.
}
