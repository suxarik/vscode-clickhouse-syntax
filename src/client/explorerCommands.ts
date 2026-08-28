/**
 * Actions on the explorer tree.
 */
import * as vscode from 'vscode';
import { AnalysisCache } from '../analysis';
import { ExplorerNode, ExplorerProvider, qualifiedName } from './explorerView';
import { QueryRunner } from './queryRunner';
import { SchemaSync } from './schemaSync';

/** Insert text at the cursor of the last active editor, or open a scratch file. */
async function insertOrOpen(text: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (editor && ['clickhouse', 'sql'].includes(editor.document.languageId)) {
        await editor.edit(builder => builder.insert(editor.selection.active, text));
        return;
    }
    const document = await vscode.workspace.openTextDocument({ language: 'clickhouse', content: text });
    await vscode.window.showTextDocument(document);
}

/** Run SQL that the user did not type, via the same gate as anything else. */
async function runGenerated(runner: QueryRunner, analysisCache: AnalysisCache, sql: string): Promise<void> {
    await runner.run({ sql, statements: analysisCache.analyze(sql).program.statements });
}

export function registerExplorerCommands(
    explorer: ExplorerProvider,
    runner: QueryRunner,
    analysisCache: AnalysisCache,
    schemaSync: SchemaSync
): vscode.Disposable[] {
    return [
        vscode.commands.registerCommand('clickhouse.refreshExplorer', async () => {
            explorer.reset();
            await schemaSync.refresh();
            explorer.refresh();
        }),

        vscode.commands.registerCommand('clickhouse.previewTable', async (node: ExplorerNode) => {
            if (node?.kind !== 'table') return;
            const limit = vscode.workspace.getConfiguration('clickhouse').get<number>('query.autoLimit', 1000);
            const name = qualifiedName(node.database, node.table.name);
            await runGenerated(
                runner,
                analysisCache,
                limit > 0 ? `SELECT * FROM ${name} LIMIT ${limit}` : `SELECT * FROM ${name}`
            );
        }),

        vscode.commands.registerCommand('clickhouse.showCreateTable', async (node: ExplorerNode) => {
            if (node?.kind !== 'table') return;
            await runGenerated(
                runner,
                analysisCache,
                `SHOW CREATE TABLE ${qualifiedName(node.database, node.table.name)}`
            );
        }),

        vscode.commands.registerCommand('clickhouse.copyQualifiedName', async (node: ExplorerNode) => {
            let text: string | undefined;
            if (node?.kind === 'table') text = qualifiedName(node.database, node.table.name);
            else if (node?.kind === 'column') text = `${qualifiedName(node.database, node.table)}.${node.column.name}`;
            else if (node?.kind === 'database') text = node.name;
            if (!text) return;
            await vscode.env.clipboard.writeText(text);
            vscode.window.setStatusBarMessage(`ClickHouse: copied ${text}`, 3000);
        }),

        vscode.commands.registerCommand('clickhouse.insertColumnList', async (node: ExplorerNode) => {
            if (node?.kind !== 'table') return;
            await insertOrOpen(node.table.columns.map(column => column.name).join(', '));
        }),

        vscode.commands.registerCommand('clickhouse.insertName', async (node: ExplorerNode) => {
            if (node?.kind === 'table') await insertOrOpen(qualifiedName(node.database, node.table.name));
            else if (node?.kind === 'column') await insertOrOpen(node.column.name);
        }),

        vscode.commands.registerCommand('clickhouse.selectFromTable', async (node: ExplorerNode) => {
            if (node?.kind !== 'table') return;
            const columns = node.table.columns.map(column => column.name).join(',\n    ');
            await insertOrOpen(
                `SELECT\n    ${columns}\nFROM ${qualifiedName(node.database, node.table.name)}\nLIMIT 100`
            );
        }),
    ];
}
