/**
 * ClickHouse SQL Extension for VS Code
 * Thin orchestrator that registers providers, commands, and listeners.
 */
import * as vscode from 'vscode';
import { SchemaManager } from './schemaManager';
import { formatSQL } from './sqlFormatter';
import { isClickHouseSQL, detectAndApplyLanguage } from './sqlContext';
import { registerHoverProvider } from './providers/hoverProvider';
import { registerCompletionProvider } from './providers/completionProvider';
import { registerSignatureHelpProvider } from './providers/signatureHelpProvider';
import { createDiagnosticCollection, updateDiagnostics } from './providers/diagnosticProvider';
import { registerCodeActionProvider, registerCodeActionCommands } from './providers/codeActionProvider';

export function activate(context: vscode.ExtensionContext) {
    console.log('ClickHouse SQL extension is now active');

    const schemaManager = new SchemaManager(context);
    context.subscriptions.push(schemaManager);

    // ── Auto-detect ClickHouse SQL in .sql files ──
    vscode.workspace.textDocuments.forEach(doc => detectAndApplyLanguage(doc));
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(doc => detectAndApplyLanguage(doc)),
        vscode.workspace.onDidSaveTextDocument(doc => detectAndApplyLanguage(doc))
    );

    // ── Commands ──
    context.subscriptions.push(
        // Manual detect language
        vscode.commands.registerCommand('clickhouse.detectLanguage', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
            const doc = editor.document;
            if (isClickHouseSQL(doc.getText())) {
                await vscode.languages.setTextDocumentLanguage(doc, 'clickhouse');
                vscode.window.showInformationMessage('Language set to ClickHouse SQL');
            } else {
                vscode.window.showWarningMessage('No ClickHouse-specific syntax detected in this file.');
            }
        }),

        // Schema management
        vscode.commands.registerCommand('clickhouse.reloadSchema', async () => {
            await schemaManager.loadSchema();
            vscode.window.showInformationMessage('ClickHouse schema reloaded');
        }),
        vscode.commands.registerCommand('clickhouse.validateSchema', async () => {
            const schema = schemaManager.getSchema();
            if (schema) {
                vscode.window.showInformationMessage('Schema is valid');
            } else {
                vscode.window.showWarningMessage('No valid schema loaded');
            }
        }),
        vscode.commands.registerCommand('clickhouse.generateSchemaTemplate', async () => {
            const template = {
                version: '1.0',
                databases: [{
                    name: 'example_db',
                    description: 'Example database',
                    tables: [{
                        name: 'example_table',
                        description: 'Example table',
                        engine: 'MergeTree',
                        engineOptions: {
                            orderBy: ['id'],
                            partitionBy: 'toYYYYMM(date)'
                        },
                        columns: [
                            { name: 'id', type: 'UInt64', description: 'Primary key' },
                            { name: 'date', type: 'Date', description: 'Event date' },
                            { name: 'value', type: 'String', description: 'Example value' }
                        ]
                    }]
                }]
            };

            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (workspaceFolder) {
                const uri = vscode.Uri.joinPath(workspaceFolder.uri, 'clickhouse-schema.json');
                await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(template, null, 2)));
                vscode.window.showInformationMessage(`Schema template created at ${uri.fsPath}`);
            }
        }),

        // Format document
        vscode.commands.registerCommand('clickhouse.formatDocument', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('ClickHouse: No active editor.');
                return;
            }
            const doc = editor.document;
            const config = vscode.workspace.getConfiguration('clickhouse');
            const keywordCase = config.get<string>('format.keywordCase', 'upper');
            const indentSize = config.get<number>('format.indentSize', 4);

            const original = doc.getText();
            const formatted = formatSQL(original, keywordCase, indentSize);

            if (formatted === original) {
                vscode.window.showInformationMessage('ClickHouse: Document is already formatted.');
                return;
            }

            const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(original.length));
            await editor.edit(editBuilder => editBuilder.replace(fullRange, formatted));
            vscode.window.showInformationMessage('ClickHouse: Document formatted.');
        })
    );

    // ── Document Formatting Providers ──
    const formatterProvider = vscode.languages.registerDocumentFormattingEditProvider(
        [{ language: 'clickhouse' }, { language: 'sql' }],
        {
            provideDocumentFormattingEdits(document: vscode.TextDocument): vscode.TextEdit[] {
                const config = vscode.workspace.getConfiguration('clickhouse');
                if (!config.get<boolean>('format.enabled', true)) return [];

                const keywordCase = config.get<string>('format.keywordCase', 'upper');
                const indentSize = config.get<number>('format.indentSize', 4);
                const text = document.getText();
                const formatted = formatSQL(text, keywordCase, indentSize);

                if (formatted === text) return [];
                const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(text.length));
                return [vscode.TextEdit.replace(fullRange, formatted)];
            }
        }
    );

    const rangeFormatterProvider = vscode.languages.registerDocumentRangeFormattingEditProvider(
        [{ language: 'clickhouse' }, { language: 'sql' }],
        {
            provideDocumentRangeFormattingEdits(document: vscode.TextDocument, range: vscode.Range): vscode.TextEdit[] {
                const config = vscode.workspace.getConfiguration('clickhouse');
                if (!config.get<boolean>('format.enabled', true)) return [];

                const keywordCase = config.get<string>('format.keywordCase', 'upper');
                const indentSize = config.get<number>('format.indentSize', 4);
                const text = document.getText(range);
                const formatted = formatSQL(text, keywordCase, indentSize);

                if (formatted === text) return [];
                return [vscode.TextEdit.replace(range, formatted)];
            }
        }
    );

    // ── IntelliSense Providers ──
    const hoverProvider = registerHoverProvider(schemaManager);
    const completionProvider = registerCompletionProvider(schemaManager);
    const signatureHelpProvider = registerSignatureHelpProvider();
    const codeActionProvider = registerCodeActionProvider(schemaManager);
    const codeActionCommands = registerCodeActionCommands(context, schemaManager);

    // ── Diagnostic Collection ──
    const diagnosticCollection = createDiagnosticCollection();

    function refreshDiagnostics(document: vscode.TextDocument) {
        updateDiagnostics(document, diagnosticCollection, schemaManager);
    }

    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document.languageId === 'clickhouse' || e.document.languageId === 'sql') {
                refreshDiagnostics(e.document);
            }
        }),
        vscode.workspace.onDidOpenTextDocument(doc => {
            if (doc.languageId === 'clickhouse' || doc.languageId === 'sql') {
                refreshDiagnostics(doc);
            }
        })
    );

    vscode.workspace.textDocuments.forEach(doc => {
        if (doc.languageId === 'clickhouse' || doc.languageId === 'sql') {
            refreshDiagnostics(doc);
        }
    });

    // ── Register all disposables ──
    context.subscriptions.push(
        formatterProvider,
        rangeFormatterProvider,
        hoverProvider,
        completionProvider,
        signatureHelpProvider,
        codeActionProvider,
        diagnosticCollection,
        ...codeActionCommands
    );
}

export function deactivate() {
    console.log('ClickHouse SQL extension deactivated');
}
