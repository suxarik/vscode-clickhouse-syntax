/**
 * The runbook templates that ship with the extension.
 *
 * These are the reason notebooks are worth having at all. For ad-hoc querying a
 * notebook adds little over the editor and the result panel; incident work is
 * different - prose, a query, its output, then the next step, against system
 * tables most people do not have memorised.
 *
 * They live as `.sql` files rather than as strings in the source so they can be
 * read, diffed and run through `clickhouse-client` like any other runbook. Each
 * one is verified against a real server.
 */
import * as vscode from 'vscode';

export interface RunbookTemplate {
    /** File under `media/runbooks`. */
    file: string;
    label: string;
    detail: string;
}

export const TEMPLATES: RunbookTemplate[] = [
    {
        file: 'slow-cluster.runbook.sql',
        label: 'Why is this cluster slow',
        detail: 'What is running now, what has been slow, what read far more than it returned, what failed.',
    },
    {
        file: 'parts-and-merges.runbook.sql',
        label: 'Which parts are not merging',
        detail: 'Parts per table, merges in flight, the replication queue, and where the disk actually went.',
    },
    {
        file: 'query-profile.runbook.sql',
        label: 'What is my query doing',
        detail: 'The plan with index pruning, then what it really cost according to system.query_log.',
    },
];

/**
 * Read a template and open it as an untitled runbook.
 *
 * Untitled rather than written to disk: a template is a starting point, and
 * where it belongs is the reader's decision, not ours.
 */
export async function openTemplate(
    extensionUri: vscode.Uri,
    template: RunbookTemplate,
    notebookType: string
): Promise<void> {
    const uri = vscode.Uri.joinPath(extensionUri, 'media', 'runbooks', template.file);
    const content = await vscode.workspace.fs.readFile(uri);

    const document = await vscode.workspace.openNotebookDocument(
        notebookType,
        await deserialize(notebookType, content)
    );
    await vscode.window.showNotebookDocument(document);
}

/** Turn the file into notebook data using the same serializer the editor uses. */
async function deserialize(_notebookType: string, content: Uint8Array): Promise<vscode.NotebookData> {
    // Imported lazily so this module stays free of a cycle through index.ts.
    const { ClickHouseNotebookSerializer } = await import('./serializer');
    return new ClickHouseNotebookSerializer().deserializeNotebook(content);
}
