/**
 * Completion provider for ClickHouse SQL.
 */
import * as vscode from 'vscode';
import { SchemaManager } from '../schemaManager';
import { CH_FUNCTION_DOCS } from '../functionDocs';
import { CH_KEYWORDS, CH_DATA_TYPES } from '../constants';
import { getSqlContext, isAfterDot } from '../sqlContext';

export function registerCompletionProvider(schemaManager: SchemaManager): vscode.Disposable {
    return vscode.languages.registerCompletionItemProvider(
        [{ language: 'clickhouse' }, { language: 'sql' }],
        {
            provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] {
                const config = vscode.workspace.getConfiguration('clickhouse');
                if (!config.get<boolean>('completion.enabled', true)) return [];

                const items: vscode.CompletionItem[] = [];
                const ctx = getSqlContext(document, position);
                const dotCheck = isAfterDot(document, position);
                const schema = schemaManager.getSchema();

                // If after a dot, provide columns for that table
                if (dotCheck.isAfter && schema) {
                    for (const db of schema.databases) {
                        for (const table of db.tables) {
                            if (table.name === dotCheck.prefix) {
                                for (const col of table.columns) {
                                    const item = new vscode.CompletionItem(col.name, vscode.CompletionItemKind.Field);
                                    item.detail = `${col.type} — ${table.name}`;
                                    item.documentation = new vscode.MarkdownString(
                                        `${col.description || ''}\n\n**Type:** \`${col.type}\``
                                    );
                                    items.push(item);
                                }
                                return items;
                            }
                        }
                    }
                }

                // Context-aware completions
                const clause = ctx.clause.toUpperCase();

                // In FROM/JOIN context — suggest tables
                if ((clause === 'FROM' || clause === 'JOIN' || clause === 'INTO') && config.get<boolean>('completion.includeTables', true)) {
                    if (schema) {
                        for (const db of schema.databases) {
                            for (const table of db.tables) {
                                const item = new vscode.CompletionItem(table.name, vscode.CompletionItemKind.Class);
                                item.detail = `Table — ${db.name}`;
                                item.documentation = new vscode.MarkdownString(
                                    `${table.description || ''}\n\n**Engine:** \`${table.engine || 'unknown'}\``
                                );
                                items.push(item);

                                // Also add fully-qualified name
                                const fqItem = new vscode.CompletionItem(`${db.name}.${table.name}`, vscode.CompletionItemKind.Class);
                                fqItem.detail = `Table — ${db.name}`;
                                items.push(fqItem);
                            }
                        }
                    }
                }

                // In SELECT/WHERE/GROUP BY/ORDER BY context — suggest columns
                if ((clause === 'SELECT' || clause === 'WHERE' || clause === 'GROUP BY' || clause === 'ORDER BY' || clause === 'HAVING') && config.get<boolean>('completion.includeColumns', true)) {
                    if (schema) {
                        const addedCols = new Set<string>();
                        for (const db of schema.databases) {
                            for (const table of db.tables) {
                                for (const col of table.columns) {
                                    if (!addedCols.has(col.name)) {
                                        const item = new vscode.CompletionItem(col.name, vscode.CompletionItemKind.Field);
                                        item.detail = `${col.type} — ${table.name}`;
                                        item.documentation = new vscode.MarkdownString(
                                            `${col.description || ''}\n\n**Type:** \`${col.type}\``
                                        );
                                        items.push(item);
                                        addedCols.add(col.name);
                                    }
                                }
                            }
                        }
                    }
                }

                // Add keywords
                if (config.get<boolean>('completion.includeKeywords', true)) {
                    for (const keyword of CH_KEYWORDS) {
                        const item = new vscode.CompletionItem(keyword, vscode.CompletionItemKind.Keyword);
                        item.detail = 'ClickHouse keyword';
                        items.push(item);
                    }
                }

                // Add functions
                if (config.get<boolean>('completion.includeFunctions', true)) {
                    for (const [name, info] of Object.entries(CH_FUNCTION_DOCS)) {
                        const item = new vscode.CompletionItem(info.name, vscode.CompletionItemKind.Function);
                        item.detail = `${info.category || 'function'} — ${info.returnType || 'function'}`;
                        item.documentation = new vscode.MarkdownString(info.description);
                        if (info.insertText) {
                            item.insertText = new vscode.SnippetString(info.insertText);
                        }
                        items.push(item);
                    }
                }

                // Add data types
                if (config.get<boolean>('completion.includeDataTypes', true)) {
                    for (const type of CH_DATA_TYPES) {
                        const item = new vscode.CompletionItem(type, vscode.CompletionItemKind.TypeParameter);
                        item.detail = 'ClickHouse data type';
                        items.push(item);
                    }
                }

                return items;
            }
        },
        '.', '(', ' ', ','
    );
}
