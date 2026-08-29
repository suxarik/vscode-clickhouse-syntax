/**
 * Notebook execution: one controller per connection profile.
 *
 * VS Code's kernel picker maps onto connection profiles exactly, which gives
 * "which server am I about to hit" a first-class, always-visible control. Per
 * cell profiles would let one file quietly span environments, which is the
 * opposite of what the safety model is for.
 *
 * Execution goes through `QueryRunner`, so a notebook cell is gated, cancelled
 * and recorded in history by the same code as the editor - a notebook cannot
 * become a way around the read-only rule.
 */
import * as vscode from 'vscode';
import { AnalysisCache } from '../analysis';
import { ConnectionManager } from '../client/connectionManager';
import { QueryRunner } from '../client/queryRunner';
import { ColumnMeta, ResultHeader, ResultStatistics } from '../results/protocol';
import { ResultSink, SinkCallbacks } from '../results/sink';
import { findParameters, ParameterStore, suggestValue } from './parameters';
import { NOTEBOOK_TYPE } from './serializer';

/** The mime type our renderer claims. Anything else falls back to text. */
export const RESULT_MIME = 'application/vnd.clickhouse.result+json';

/** What the renderer is handed. Ephemeral: it is never serialized to the file. */
export interface CellResult {
    header: ResultHeader;
    columns: ColumnMeta[];
    rows: unknown[][];
    statistics?: ResultStatistics;
    truncated: boolean;
    error?: string;
}

/**
 * Collects a query into a notebook cell output.
 *
 * Rows are gathered and written once at the end rather than replaced on every
 * batch: a notebook output is a document edit, and editing it a hundred times a
 * second to show a progress count would cost more than it tells anyone.
 */
class CellSink implements ResultSink {
    private result: CellResult | undefined;
    private cancel: (() => void) | undefined;
    /** Whether the execution has been ended, so the caller does not end it twice. */
    finished = false;

    constructor(private readonly execution: vscode.NotebookCellExecution) {}

    noteTransport(): void {
        // The diagnostic log belongs to the panel; a cell has nowhere to show it.
    }

    trace(): void {
        // As above.
    }

    begin(header: ResultHeader, callbacks: SinkCallbacks): void {
        this.result = { header, columns: [], rows: [], truncated: false };
        this.cancel = callbacks.onCancel;
        this.execution.token.onCancellationRequested(() => this.cancel?.());
    }

    setColumns(columns: ColumnMeta[]): void {
        if (this.result) this.result.columns = columns;
    }

    appendRows(rows: unknown[][]): void {
        if (this.result) for (const row of rows) this.result.rows.push(row);
    }

    end(statistics: ResultStatistics, truncated: boolean): void {
        if (!this.result) return;
        this.result.statistics = statistics;
        this.result.truncated = truncated;
        void this.execution.replaceOutput(outputFor(this.result));
        this.finish(true);
    }

    fail(message: string, code?: number): void {
        const text = code !== undefined ? `${message} (code ${code})` : message;
        void this.execution.replaceOutput(
            new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.error(new Error(text))])
        );
        this.finish(false);
    }

    cancelled(): void {
        void this.execution.replaceOutput(
            new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.text('Query cancelled.', 'text/plain')])
        );
        this.finish(false);
    }

    finish(success: boolean | undefined): void {
        if (this.finished) return;
        this.finished = true;
        this.execution.end(success, Date.now());
    }
}

/** A one-line summary, so an output still says something without the renderer. */
export function summaryText(result: CellResult): string {
    const rows = result.rows.length;
    const columns = result.columns.map(column => column.name).join(', ');
    const elapsed = result.statistics?.elapsedMs;
    const parts = [`${rows.toLocaleString()} row${rows === 1 ? '' : 's'}`];
    if (columns) parts.push(columns);
    if (elapsed !== undefined) parts.push(`${elapsed} ms`);
    if (result.truncated) parts.push('truncated');
    return `${parts.join('  ·  ')}\n`;
}

function outputFor(result: CellResult): vscode.NotebookCellOutput {
    return new vscode.NotebookCellOutput([
        vscode.NotebookCellOutputItem.json(result, RESULT_MIME),
        // Read in a diff, on a machine without the extension, or by a screen
        // reader, the output is still worth something.
        vscode.NotebookCellOutputItem.text(summaryText(result), 'text/plain'),
    ]);
}

/**
 * Keeps one VS Code controller alive per configured profile.
 *
 * Profiles come and go as settings change, so the set is rebuilt rather than
 * assumed; a controller for a profile that no longer exists would offer to run
 * against a server that is not there.
 */
export class NotebookControllers implements vscode.Disposable {
    private readonly controllers = new Map<string, vscode.NotebookController>();
    private readonly watcher: vscode.Disposable;

    constructor(
        private readonly connections: ConnectionManager,
        private readonly runner: QueryRunner,
        private readonly analysisCache: AnalysisCache,
        private readonly parameters: ParameterStore = new ParameterStore()
    ) {
        this.sync();
        this.watcher = vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('clickhouse.connections')) this.sync();
        });
    }

    /** Match the live controllers to the configured profiles. */
    private sync(): void {
        const profiles = this.connections.profiles();
        const wanted = new Set(profiles.map(profile => profile.name));

        for (const [name, controller] of this.controllers) {
            if (wanted.has(name)) continue;
            controller.dispose();
            this.controllers.delete(name);
        }

        for (const profile of profiles) {
            if (this.controllers.has(profile.name)) continue;
            const controller = vscode.notebooks.createNotebookController(
                `clickhouse-${profile.name}`,
                NOTEBOOK_TYPE,
                profile.name
            );
            controller.supportedLanguages = ['clickhouse', 'sql'];
            controller.supportsExecutionOrder = true;
            // Say plainly what this kernel is allowed to do, because the
            // difference matters more here than the hostname does.
            controller.description = profile.allowWrite
                ? `${profile.host} · writes permitted${profile.protected ? ', protected' : ''}`
                : `${profile.host} · read-only`;
            controller.executeHandler = (cells, notebook, self) => this.execute(cells, notebook, self);
            controller.interruptHandler = async () => void (await this.runner.cancel());
            this.controllers.set(profile.name, controller);
        }
    }

    /**
     * Run the selected cells in order, stopping at the first failure.
     *
     * Sequential and stop-on-error, because a runbook is a sequence: cell three
     * usually only makes sense if cell two said what it was expected to say.
     */
    private async execute(
        cells: vscode.NotebookCell[],
        notebook: vscode.NotebookDocument,
        controller: vscode.NotebookController
    ): Promise<void> {
        // Running a cell is a statement of intent about which server to use.
        await this.connections.setActiveProfile(controller.label);

        for (const cell of cells) {
            const execution = controller.createNotebookCellExecution(cell);
            execution.executionOrder = nextOrder();
            execution.start(Date.now());

            const sql = cell.document.getText().trim();
            if (!sql) {
                await execution.replaceOutput([]);
                execution.end(true, Date.now());
                continue;
            }

            const values = await this.resolveParameters(notebook, sql);
            if (!values) {
                // The prompt was dismissed: nothing ran, so say nothing ran.
                execution.end(undefined, Date.now());
                break;
            }

            const sink = new CellSink(execution);
            const statements = this.analysisCache.analyze(sql).program.statements;
            await this.runner.run({ sql, statements, parameters: values }, sink);

            // A gate that refused, or a profile that vanished, means the sink
            // never saw a result at all. Ending it here stops the cell spinning
            // forever, and marks it neither passed nor failed - because nothing ran.
            sink.finish(undefined);
            if (!ranSuccessfully(cell)) break;
        }
    }

    /**
     * Fill in every `{name:Type}` the cell uses, asking once per notebook.
     *
     * `undefined` means the prompt was dismissed, which is a decision not to
     * run rather than a reason to send an unsubstituted query.
     */
    private async resolveParameters(
        notebook: vscode.NotebookDocument,
        sql: string
    ): Promise<Record<string, string> | undefined> {
        const key = notebook.uri.toString();
        const wanted = findParameters(sql);
        if (wanted.length === 0) return {};

        const missing = this.parameters.missing(key, wanted);
        for (const [index, parameter] of missing.entries()) {
            const value = await vscode.window.showInputBox({
                title:
                    missing.length > 1
                        ? `Runbook parameter (${index + 1}/${missing.length})`
                        : 'Runbook parameter',
                prompt: `${parameter.name} · ${parameter.type}`,
                value: suggestValue(parameter.type),
                ignoreFocusOut: true,
            });
            if (value === undefined) return undefined;
            this.parameters.set(key, parameter.name, value);
        }

        return this.parameters.values(key);
    }

    /** Forget what was entered, so the next run asks again. */
    clearParameters(notebook: vscode.NotebookDocument): void {
        this.parameters.clear(notebook.uri.toString());
    }

    dispose(): void {
        this.parameters.forget();
        this.watcher.dispose();
        for (const controller of this.controllers.values()) controller.dispose();
        this.controllers.clear();
    }
}

/** Did the cell end up with an error output? */
function ranSuccessfully(cell: vscode.NotebookCell): boolean {
    return !cell.outputs.some(output =>
        output.items.some(item => item.mime === 'application/vnd.code.notebook.error')
    );
}

let order = 0;
function nextOrder(): number {
    return ++order;
}
