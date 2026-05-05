/**
 * Code action provider for ClickHouse SQL with quick fixes and refactorings.
 */
import * as vscode from 'vscode';
import { SchemaManager } from '../schemaManager';

export function registerCodeActionProvider(schemaManager: SchemaManager): vscode.Disposable {
    return vscode.languages.registerCodeActionsProvider(
        [{ language: 'clickhouse' }, { language: 'sql' }],
        {
            provideCodeActions(document: vscode.TextDocument, range: vscode.Range): vscode.CodeAction[] {
                const config = vscode.workspace.getConfiguration('clickhouse');
                if (!config.get<boolean>('codeActions.enabled', true)) return [];

                const actions: vscode.CodeAction[] = [];
                const text = document.getText(range);
                const fullText = document.getText();

                // Quick fix: expand SELECT *
                if (config.get<boolean>('codeActions.quickFixes', true) && /SELECT\s+\*/i.test(fullText)) {
                    const action = new vscode.CodeAction('ClickHouse: Replace SELECT * with column list', vscode.CodeActionKind.QuickFix);
                    action.command = {
                        command: 'clickhouse.expandSelectStar',
                        title: 'Expand SELECT *',
                        arguments: [document.uri]
                    };
                    actions.push(action);
                }

                // Transformation: convert CASE to multiIf
                if (config.get<boolean>('codeActions.transformations', true) && /CASE\s+WHEN/i.test(text)) {
                    const action = new vscode.CodeAction('ClickHouse: Convert CASE to multiIf', vscode.CodeActionKind.RefactorRewrite);
                    action.command = {
                        command: 'clickhouse.convertCaseToMultiIf',
                        title: 'Convert CASE to multiIf',
                        arguments: [document.uri, range]
                    };
                    actions.push(action);
                }

                // Refactoring: convert simple WHERE to PREWHERE
                if (config.get<boolean>('codeActions.refactorings', true) && /\bWHERE\b/i.test(fullText) && !/\bPREWHERE\b/i.test(fullText)) {
                    const action = new vscode.CodeAction('ClickHouse: Convert date filter to PREWHERE', vscode.CodeActionKind.RefactorRewrite);
                    action.command = {
                        command: 'clickhouse.convertToPrewhere',
                        title: 'Convert to PREWHERE',
                        arguments: [document.uri]
                    };
                    actions.push(action);
                }

                // Advanced: add FINAL for Replacing/Collapsing MergeTree
                if (config.get<boolean>('codeActions.refactorings', true)) {
                    const schema = schemaManager.getSchema();
                    if (schema) {
                        const fromMatch = fullText.match(/\bFROM\s+(\w+(?:\.\w+)?)/i);
                        if (fromMatch) {
                            const tableName = fromMatch[1].includes('.') ? fromMatch[1].split('.')[1] : fromMatch[1];
                            const engine = schemaManager.getEngine(tableName);
                            if (engine && /(Replacing|Collapsing|VersionedCollapsing)MergeTree/i.test(engine)) {
                                if (!/\bFINAL\b/i.test(fullText)) {
                                    const action = new vscode.CodeAction(`ClickHouse: Add FINAL for ${tableName}`, vscode.CodeActionKind.RefactorRewrite);
                                    action.command = {
                                        command: 'clickhouse.addFinal',
                                        title: 'Add FINAL',
                                        arguments: [document.uri, tableName]
                                    };
                                    actions.push(action);
                                }
                            }
                        }
                    }
                }

                // Advanced: suggest index hint for equality filters
                if (config.get<boolean>('codeActions.quickFixes', true)) {
                    const eqFilterMatch = fullText.match(/\bWHERE\b[\s\S]*?(\w+)\s*=\s*[^\s,)]+/i);
                    if (eqFilterMatch && !/indexHint/i.test(fullText)) {
                        const action = new vscode.CodeAction('ClickHouse: Wrap equality filter in indexHint', vscode.CodeActionKind.QuickFix);
                        action.command = {
                            command: 'clickhouse.addIndexHint',
                            title: 'Add indexHint',
                            arguments: [document.uri, eqFilterMatch[1]]
                        };
                        actions.push(action);
                    }
                }

                return actions;
            }
        }
    );
}

/**
 * Register all code action command handlers.
 */
export function registerCodeActionCommands(context: vscode.ExtensionContext, schemaManager: SchemaManager): vscode.Disposable[] {
    return [
        vscode.commands.registerCommand('clickhouse.expandSelectStar', async (uri: vscode.Uri) => {
            const doc = await vscode.workspace.openTextDocument(uri);
            const text = doc.getText();
            const fromMatch = text.match(/\bFROM\s+(\w+(?:\.\w+)?)/i);
            if (fromMatch) {
                const tableName = fromMatch[1].includes('.') ? fromMatch[1].split('.')[1] : fromMatch[1];
                const tableInfo = schemaManager.findTable(tableName);
                if (tableInfo) {
                    const colList = tableInfo.table.columns.map(c => c.name).join(', ');
                    const newText = text.replace(/SELECT\s+\*/i, `SELECT ${colList}`);
                    if (newText !== text) {
                        const editor = await vscode.window.showTextDocument(doc);
                        const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(text.length));
                        await editor.edit(eb => eb.replace(fullRange, newText));
                    }
                } else {
                    vscode.window.showInformationMessage(`Table: ${fromMatch[1]} — Use schema definition for column expansion`);
                }
            }
        }),

        vscode.commands.registerCommand('clickhouse.convertCaseToMultiIf', async (uri: vscode.Uri, range: vscode.Range) => {
            const doc = await vscode.workspace.openTextDocument(uri);
            const text = doc.getText(range);
            // Simple conversion for basic CASE WHEN ... THEN ... ELSE ... END
            const caseMatch = text.match(/CASE\s+WHEN\s+(.+?)\s+THEN\s+(.+?)(?:\s+ELSE\s+(.+?))?\s+END/si);
            if (caseMatch) {
                const multiIf = `multiIf(${caseMatch[1].trim()}, ${caseMatch[2].trim()}, ${caseMatch[3] ? caseMatch[3].trim() : 'NULL'})`;
                const editor = await vscode.window.showTextDocument(doc);
                await editor.edit(eb => eb.replace(range, multiIf));
            } else {
                vscode.window.showInformationMessage('CASE to multiIf conversion: complex CASE statements require manual editing');
            }
        }),

        vscode.commands.registerCommand('clickhouse.convertToPrewhere', async (uri: vscode.Uri) => {
            const doc = await vscode.workspace.openTextDocument(uri);
            const editor = await vscode.window.showTextDocument(doc);
            const text = doc.getText();
            const newText = text.replace(/\bWHERE\s+(\w+\s*=\s*[^\s]+)/i, 'PREWHERE $1 WHERE');
            if (newText !== text) {
                const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(text.length));
                await editor.edit(eb => eb.replace(fullRange, newText));
            }
        }),

        vscode.commands.registerCommand('clickhouse.addFinal', async (uri: vscode.Uri, tableName: string) => {
            const doc = await vscode.workspace.openTextDocument(uri);
            const editor = await vscode.window.showTextDocument(doc);
            const text = doc.getText();
            const regex = new RegExp(`\\bFROM\\s+${tableName}\\b`, 'i');
            const newText = text.replace(regex, `FROM ${tableName} FINAL`);
            if (newText !== text) {
                const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(text.length));
                await editor.edit(eb => eb.replace(fullRange, newText));
            }
        }),

        vscode.commands.registerCommand('clickhouse.addIndexHint', async (uri: vscode.Uri, columnName: string) => {
            const doc = await vscode.workspace.openTextDocument(uri);
            const editor = await vscode.window.showTextDocument(doc);
            const text = doc.getText();
            const regex = new RegExp(`\\b(${columnName}\\s*=\\s*[^\\s,)]+)`, 'i');
            const newText = text.replace(regex, 'indexHint($1)');
            if (newText !== text) {
                const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(text.length));
                await editor.edit(eb => eb.replace(fullRange, newText));
            }
        }),
    ];
}
