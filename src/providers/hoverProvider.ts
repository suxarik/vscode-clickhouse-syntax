/**
 * Hover provider for ClickHouse SQL.
 */
import * as vscode from 'vscode';
import { SchemaManager } from '../schemaManager';
import { CH_FUNCTION_DOCS } from '../functionDocs';
import { CH_DATA_TYPES } from '../constants';

export function registerHoverProvider(schemaManager: SchemaManager): vscode.Disposable {
    return vscode.languages.registerHoverProvider(
        [{ language: 'clickhouse' }, { language: 'sql' }],
        {
            provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
                const config = vscode.workspace.getConfiguration('clickhouse');
                if (!config.get<boolean>('hover.enabled', true)) return undefined;

                const range = document.getWordRangeAtPosition(position, /[a-zA-Z_][a-zA-Z0-9_]*/);
                if (!range) return undefined;

                const word = document.getText(range);
                const lowerWord = word.toLowerCase();
                const info = CH_FUNCTION_DOCS[lowerWord];

                if (info) {
                    const md = new vscode.MarkdownString();
                    md.appendMarkdown(`**${info.name}** — *${info.category || 'function'}*\n\n`);
                    md.appendMarkdown(`${info.description}\n\n`);

                    if (config.get<boolean>('hover.showFunctionSignature', true) && info.signature) {
                        md.appendCodeblock(info.signature, 'clickhouse');
                    }
                    if (config.get<boolean>('hover.showColumnType', true) && info.returnType) {
                        md.appendMarkdown(`**Returns:** \`${info.returnType}\`\n\n`);
                    }
                    if (config.get<boolean>('hover.showExamples', true) && info.example) {
                        md.appendMarkdown(`**Example:**\n`);
                        md.appendCodeblock(info.example, 'clickhouse');
                    }

                    md.isTrusted = true;
                    return new vscode.Hover(md, range);
                }

                // Check if it's a data type
                if (CH_DATA_TYPES.includes(word)) {
                    const md = new vscode.MarkdownString();
                    md.appendMarkdown(`**${word}** — *ClickHouse data type*\n\n`);
                    md.appendMarkdown(`ClickHouse native data type.`);
                    return new vscode.Hover(md, range);
                }

                // Check schema for table/column
                if (config.get<boolean>('hover.showTableSchema', true)) {
                    const schema = schemaManager.getSchema();
                    if (schema) {
                        for (const db of schema.databases) {
                            for (const table of db.tables) {
                                if (table.name === word) {
                                    const md = new vscode.MarkdownString();
                                    md.appendMarkdown(`**${db.name}.${table.name}** — *Table*\n\n`);
                                    if (table.description) md.appendMarkdown(`${table.description}\n\n`);
                                    if (table.engine) md.appendMarkdown(`**Engine:** \`${table.engine}\`\n\n`);
                                    if (table.columns.length > 0) {
                                        md.appendMarkdown('| Column | Type | Description |\n');
                                        md.appendMarkdown('|---|---|---|\n');
                                        for (const col of table.columns) {
                                            md.appendMarkdown(`| ${col.name} | \`${col.type}\` | ${col.description || ''} |\n`);
                                        }
                                    }
                                    md.isTrusted = true;
                                    return new vscode.Hover(md, range);
                                }
                                for (const col of table.columns) {
                                    if (col.name === word) {
                                        const md = new vscode.MarkdownString();
                                        md.appendMarkdown(`**${col.name}** — *Column*\n\n`);
                                        if (col.description) md.appendMarkdown(`${col.description}\n\n`);
                                        md.appendMarkdown(`**Type:** \`${col.type}\`\n\n`);
                                        if (col.defaultValue) md.appendMarkdown(`**Default:** \`${col.defaultValue}\`\n\n`);
                                        return new vscode.Hover(md, range);
                                    }
                                }
                            }
                        }
                    }
                }

                return undefined;
            }
        }
    );
}
