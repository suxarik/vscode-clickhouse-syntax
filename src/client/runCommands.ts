/**
 * Running queries from the editor: the Run CodeLens, the commands behind it,
 * and cancellation.
 */
import * as vscode from 'vscode';
import { AnalysisCache } from '../analysis';
import { classifyStatement } from './safety';
import { QueryRunner, resolveTarget } from './queryRunner';

const SELECTOR = [{ language: 'clickhouse' }, { language: 'sql' }];

/** A `▷ Run` lens above every statement. */
export function registerRunCodeLens(analysisCache: AnalysisCache): vscode.Disposable {
    return vscode.languages.registerCodeLensProvider(SELECTOR, {
        provideCodeLenses(document) {
            const config = vscode.workspace.getConfiguration('clickhouse');
            if (!config.get<boolean>('query.showRunCodeLens', true)) return [];

            try {
                const { program } = analysisCache.get(document);
                return program.statements.map(statement => {
                    const range = new vscode.Range(
                        document.positionAt(statement.start),
                        document.positionAt(statement.start)
                    );
                    const summary = classifyStatement(statement);
                    // A destructive statement says so in the lens, before anyone clicks.
                    const title =
                        summary.effect === 'destructive'
                            ? `$(warning) Run ${summary.label}`
                            : `$(play) Run ${summary.label}`;
                    return new vscode.CodeLens(range, {
                        command: 'clickhouse.runStatementAt',
                        title,
                        arguments: [document.uri, statement.start],
                    });
                });
            } catch (err) {
                console.error('ClickHouse: run CodeLens failed', err);
                return [];
            }
        },
    });
}

export function registerRunCommands(runner: QueryRunner, analysisCache: AnalysisCache): vscode.Disposable[] {
    return [
        vscode.commands.registerCommand('clickhouse.runQuery', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
            const target = resolveTarget(editor.document, editor.selection, analysisCache);
            if (!target) {
                vscode.window.showInformationMessage('ClickHouse: nothing to run at the cursor.');
                return;
            }
            await runner.run(target);
        }),

        vscode.commands.registerCommand(
            'clickhouse.runStatementAt',
            async (uri: vscode.Uri, offset: number) => {
                const document = await vscode.workspace.openTextDocument(uri);
                const position = document.positionAt(offset);
                const target = resolveTarget(document, new vscode.Selection(position, position), analysisCache);
                if (target) await runner.run(target);
            }
        ),

        vscode.commands.registerCommand('clickhouse.cancelQuery', async () => {
            if (!runner.isRunning) {
                vscode.window.showInformationMessage('ClickHouse: no query is running.');
                return;
            }
            await runner.cancel();
        }),
    ];
}
