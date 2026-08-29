/**
 * Registering the notebook: serializer, controllers, and the renderer channel.
 *
 * Kept in one place so `extension.ts` gains a single call, and so the one thing
 * worth restating lives next to the code that guarantees it: nothing here ever
 * writes a query result to disk unless someone explicitly asks for a file.
 */
import * as vscode from 'vscode';
import { AnalysisCache } from '../analysis';
import { ConnectionManager } from '../client/connectionManager';
import { QueryRunner } from '../client/queryRunner';
import { FILE_EXTENSION } from '../results/serialize';
import { SerializationFormat } from '../results/protocol';
import { NotebookControllers, RESULT_MIME } from './controller';
import { ClickHouseNotebookSerializer, NOTEBOOK_TYPE } from './serializer';

export { NOTEBOOK_TYPE, RESULT_MIME };
export const RENDERER_ID = 'clickhouse-result-grid';

/** What the renderer sends back when someone copies or exports a result. */
interface RendererRequest {
    type: 'copy' | 'export';
    format: SerializationFormat;
    text: string;
    suggestedName?: string;
}

function isRendererRequest(message: unknown): message is RendererRequest {
    if (typeof message !== 'object' || message === null) return false;
    const candidate = message as Partial<RendererRequest>;
    return (
        (candidate.type === 'copy' || candidate.type === 'export') &&
        typeof candidate.text === 'string' &&
        typeof candidate.format === 'string'
    );
}

async function handleRendererRequest(request: RendererRequest): Promise<void> {
    if (request.type === 'copy') {
        await vscode.env.clipboard.writeText(request.text);
        vscode.window.setStatusBarMessage(`ClickHouse: copied as ${request.format.toUpperCase()}`, 2000);
        return;
    }

    const extension = FILE_EXTENSION[request.format] ?? 'txt';
    const uri = await vscode.window.showSaveDialog({
        filters: { [request.format.toUpperCase()]: [extension] },
        defaultUri: vscode.Uri.file(`${request.suggestedName ?? 'clickhouse-result'}.${extension}`),
    });
    if (!uri) return;
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(request.text));
    vscode.window.showInformationMessage(`ClickHouse: exported to ${uri.fsPath}`);
}

export function registerNotebook(
    connections: ConnectionManager,
    runner: QueryRunner,
    analysisCache: AnalysisCache
): vscode.Disposable[] {
    const messaging = vscode.notebooks.createRendererMessaging(RENDERER_ID);

    return [
        vscode.workspace.registerNotebookSerializer(NOTEBOOK_TYPE, new ClickHouseNotebookSerializer(), {
            // Outputs are not part of the file, so there is nothing to hold in
            // the backup either. This is the format's whole point.
            transientOutputs: true,
            transientCellMetadata: { marker: false, trailingBlankLines: false },
        }),
        new NotebookControllers(connections, runner, analysisCache),
        messaging.onDidReceiveMessage(event => {
            if (isRendererRequest(event.message)) void handleRendererRequest(event.message);
        }),

        vscode.commands.registerCommand('clickhouse.openAsNotebook', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showInformationMessage('ClickHouse: open a SQL file to run it as a notebook.');
                return;
            }
            await vscode.commands.executeCommand('vscode.openWith', editor.document.uri, NOTEBOOK_TYPE);
        }),

        vscode.commands.registerCommand('clickhouse.newNotebook', async () => {
            const document = await vscode.workspace.openNotebookDocument(
                NOTEBOOK_TYPE,
                new vscode.NotebookData([
                    new vscode.NotebookCellData(
                        vscode.NotebookCellKind.Markup,
                        '# Untitled runbook\n\nWhat are you trying to find out?',
                        'markdown'
                    ),
                    new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'SELECT 1', 'clickhouse'),
                ])
            );
            await vscode.window.showNotebookDocument(document);
        }),
    ];
}
