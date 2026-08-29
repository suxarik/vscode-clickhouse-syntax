/**
 * The webview that hosts the result grid.
 *
 * The panel owns the transport and the actions that need the extension host —
 * clipboard, file export, cancellation — and knows nothing about how the grid
 * renders.
 */
import * as vscode from 'vscode';
import { ColumnMeta, HostMessage, ResultHeader, ResultStatistics, SerializationFormat, ViewMessage } from './protocol';
import { FILE_EXTENSION, serialize } from './serialize';
import { GRID_STYLE } from './view/style';
import { ResultSink, SinkCallbacks } from './sink';

/** Kept as an alias so existing callers read the same. */
export type PanelCallbacks = SinkCallbacks;

function nonce(): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let value = '';
    for (let i = 0; i < 32; i++) value += alphabet[Math.floor(Math.random() * alphabet.length)];
    return value;
}

export class ResultsPanel implements vscode.Disposable, ResultSink {
    private panel: vscode.WebviewPanel | undefined;
    private ready = false;
    private queued: HostMessage[] = [];
    private callbacks: PanelCallbacks | undefined;

    /** Kept so copy and export can serialise without asking the view. */
    private header: ResultHeader | undefined;
    private columns: ColumnMeta[] = [];
    private rows: unknown[][] = [];
    private readonly log = vscode.window.createOutputChannel('ClickHouse Results');
    private loadWatchdog: ReturnType<typeof setTimeout> | undefined;

    constructor(private readonly extensionUri: vscode.Uri) {}

    private ensurePanel(): vscode.WebviewPanel {
        if (this.panel) return this.panel;

        const panel = vscode.window.createWebviewPanel(
            'clickhouseResults',
            'ClickHouse Results',
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')],
            }
        );

        panel.webview.html = this.html(panel.webview);
        panel.webview.onDidReceiveMessage((message: ViewMessage) => this.onViewMessage(message));
        panel.onDidDispose(() => {
            this.panel = undefined;
            this.ready = false;
            this.queued = [];
        });

        this.panel = panel;
        return panel;
    }

    private html(webview: vscode.Webview): string {
        const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'results.js'));
        const id = nonce();
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${id}';" />
<style>${GRID_STYLE}</style>
</head>
<body><div id="root"></div><script nonce="${id}" src="${script}"></script></body>
</html>`;
    }

    private onViewMessage(message: ViewMessage): void {
        switch (message.type) {
            case 'ready':
                this.ready = true;
                if (this.loadWatchdog) clearTimeout(this.loadWatchdog);
                this.loadWatchdog = undefined;
                this.log.appendLine(`view ready; flushing ${this.queued.length} queued message(s)`);
                for (const queued of this.queued) void this.panel?.webview.postMessage(queued);
                this.queued = [];
                break;
            case 'cancel':
                this.callbacks?.onCancel();
                break;
            case 'copy':
                void this.copy(message.format);
                break;
            case 'export':
                void this.export(message.format);
                break;
        }
    }

    private async copy(format: SerializationFormat): Promise<void> {
        if (!this.header) return;
        const text = serialize({ columns: this.columns, rows: this.rows }, format);
        await vscode.env.clipboard.writeText(text);
        vscode.window.setStatusBarMessage(
            `ClickHouse: ${this.rows.length} row(s) copied as ${format.toUpperCase()}`,
            3000
        );
    }

    private async export(format: SerializationFormat): Promise<void> {
        if (!this.header) return;
        const target = await vscode.window.showSaveDialog({
            filters: { [format.toUpperCase()]: [FILE_EXTENSION[format]] },
            saveLabel: 'Export result',
        });
        if (!target) return;

        const text = serialize({ columns: this.columns, rows: this.rows }, format);
        await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(text));
        vscode.window.showInformationMessage(`ClickHouse: result exported to ${target.fsPath}`);
    }

    private send(message: HostMessage): void {
        if (!this.panel) return;
        const size = message.type === 'rows' ? ` (${message.rows.length} rows)` : '';
        this.log.appendLine(`${this.ready ? 'send' : 'queue'} ${message.type}${size}`);
        // Messages sent before the view says it is ready would be dropped.
        if (!this.ready) this.queued.push(message);
        else void this.panel.webview.postMessage(message);
    }

    /**
     * A results view that never loads leaves a blank panel and no explanation.
     * Say so rather than letting it look like an empty result.
     */
    private watchForLoad(): void {
        if (this.ready || this.loadWatchdog) return;
        this.loadWatchdog = setTimeout(() => {
            this.loadWatchdog = undefined;
            if (this.ready) return;
            this.log.appendLine('view did not load within 5s; results cannot be displayed');
            void vscode.window
                .showErrorMessage(
                    'ClickHouse: the results view did not load, so the result cannot be shown.',
                    'Show Log'
                )
                .then(choice => {
                    if (choice === 'Show Log') this.log.show(true);
                });
        }, 5000);
    }

    // ── Public surface ───────────────────────────────────────────────────────

    /** Recorded once, so a diagnosis does not have to guess the transport. */
    noteTransport(name: string): void {
        this.log.appendLine(`transport: ${name}`);
    }

    /** Progress notes from the client, for the diagnostics log. */
    trace(note: string): void {
        this.log.appendLine(`  ${note}`);
    }

    begin(header: ResultHeader, callbacks: PanelCallbacks): void {
        const panel = this.ensurePanel();
        panel.title = `ClickHouse: ${header.profile}`;
        panel.reveal(vscode.ViewColumn.Beside, true);

        this.callbacks = callbacks;
        this.header = header;
        this.columns = [];
        this.rows = [];
        this.log.appendLine(`--- ${header.profile}: ${header.query.replace(/\s+/g, ' ').slice(0, 80)}`);
        this.send({ type: 'begin', header });
        this.watchForLoad();
    }

    setColumns(columns: ColumnMeta[]): void {
        this.columns = columns;
        this.send({ type: 'columns', columns });
    }

    appendRows(rows: unknown[][], total: number): void {
        // Spreading a large array into push overflows the stack, so append in place.
        for (const row of rows) this.rows.push(row);
        this.send({ type: 'rows', rows, total });
    }

    end(statistics: ResultStatistics, truncated: boolean): void {
        this.send({ type: 'end', statistics, truncated });
    }

    fail(message: string, code?: number): void {
        this.send({ type: 'error', message, code });
    }

    cancelled(): void {
        this.send({ type: 'cancelled' });
    }

    dispose(): void {
        if (this.loadWatchdog) clearTimeout(this.loadWatchdog);
        this.log.dispose();
        this.panel?.dispose();
        this.panel = undefined;
    }
}
