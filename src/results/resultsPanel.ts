/**
 * The webview that hosts the result grid.
 *
 * The panel owns the transport and the actions that need the extension host —
 * clipboard, file export, cancellation — and knows nothing about how the grid
 * renders.
 */
import * as vscode from 'vscode';
import { HostMessage, ResultHeader, ResultStatistics, SerializationFormat, ViewMessage } from './protocol';
import { FILE_EXTENSION, serialize } from './serialize';

export interface PanelCallbacks {
    onCancel(): void;
}

function nonce(): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let value = '';
    for (let i = 0; i < 32; i++) value += alphabet[Math.floor(Math.random() * alphabet.length)];
    return value;
}

export class ResultsPanel implements vscode.Disposable {
    private panel: vscode.WebviewPanel | undefined;
    private ready = false;
    private queued: HostMessage[] = [];
    private callbacks: PanelCallbacks | undefined;

    /** Kept so copy and export can serialise without asking the view. */
    private header: ResultHeader | undefined;
    private rows: unknown[][] = [];

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
<style>${STYLE}</style>
</head>
<body><div id="root"></div><script nonce="${id}" src="${script}"></script></body>
</html>`;
    }

    private onViewMessage(message: ViewMessage): void {
        switch (message.type) {
            case 'ready':
                this.ready = true;
                for (const queued of this.queued) this.panel?.webview.postMessage(queued);
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
        const text = serialize({ columns: this.header.columns, rows: this.rows }, format);
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

        const text = serialize({ columns: this.header.columns, rows: this.rows }, format);
        await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(text));
        vscode.window.showInformationMessage(`ClickHouse: result exported to ${target.fsPath}`);
    }

    private send(message: HostMessage): void {
        if (!this.panel) return;
        // Messages sent before the view says it is ready would be dropped.
        if (!this.ready) this.queued.push(message);
        else void this.panel.webview.postMessage(message);
    }

    // ── Public surface ───────────────────────────────────────────────────────

    begin(header: ResultHeader, callbacks: PanelCallbacks): void {
        const panel = this.ensurePanel();
        panel.title = `ClickHouse: ${header.profile}`;
        panel.reveal(vscode.ViewColumn.Beside, true);

        this.callbacks = callbacks;
        this.header = header;
        this.rows = [];
        this.send({ type: 'begin', header });
    }

    appendRows(rows: unknown[][], total: number): void {
        this.rows.push(...rows);
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
        this.panel?.dispose();
        this.panel = undefined;
    }
}

const STYLE = `
:root { --ch-border: var(--vscode-panel-border, rgba(128,128,128,.35)); }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 0; overflow: hidden;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: var(--vscode-editor-font-size, 12px);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
}
.ch-results { display: flex; flex-direction: column; height: 100vh; }
.ch-toolbar {
  display: flex; align-items: center; gap: 8px; padding: 4px 8px;
  border-bottom: 1px solid var(--ch-border);
  font-family: var(--vscode-font-family);
}
.ch-filter {
  background: var(--vscode-input-background); color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent);
  padding: 2px 6px; min-width: 180px;
}
.ch-spacer-flex { flex: 1; }
.ch-menu { display: flex; align-items: center; gap: 2px; opacity: .8; font-size: 11px; }
.ch-menu button, .ch-cancel {
  background: var(--vscode-button-secondaryBackground, transparent);
  color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  border: 1px solid var(--ch-border); padding: 1px 6px; cursor: pointer; font-size: 11px;
}
.ch-menu button:hover, .ch-cancel:hover { background: var(--vscode-button-secondaryHoverBackground); }
.ch-cancel { color: var(--vscode-errorForeground); }
.ch-message {
  padding: 8px 12px; color: var(--vscode-errorForeground);
  background: var(--vscode-inputValidation-errorBackground, transparent);
  border-bottom: 1px solid var(--ch-border); white-space: pre-wrap;
  font-family: var(--vscode-font-family);
}
.ch-head { overflow: hidden; border-bottom: 1px solid var(--ch-border); }
.ch-scroller { flex: 1; overflow: auto; position: relative; }
.ch-spacer { position: absolute; top: 0; left: 0; width: 1px; }
.ch-table { position: absolute; top: 0; left: 0; right: 0; }
.ch-row { display: flex; white-space: nowrap; }
.ch-row:nth-child(even) { background: var(--vscode-list-hoverBackground, transparent); }
.ch-header-row { background: var(--vscode-editorWidget-background); font-weight: 600; }
.ch-cell {
  padding: 2px 8px; min-width: 60px; max-width: 480px; flex: 0 0 auto;
  overflow: hidden; text-overflow: ellipsis; line-height: 18px;
  border-right: 1px solid var(--ch-border);
}
.ch-header-cell { cursor: pointer; user-select: none; }
.ch-header-cell:hover { background: var(--vscode-list-hoverBackground); }
.ch-gutter {
  min-width: 48px; text-align: right; opacity: .5;
  position: sticky; left: 0; background: var(--vscode-editor-background);
}
.is-numeric { text-align: right; font-variant-numeric: tabular-nums; }
.is-null { opacity: .45; font-style: italic; }
.is-composite { cursor: pointer; text-decoration: underline dotted; text-underline-offset: 3px; }
.ch-footer {
  padding: 3px 10px; border-top: 1px solid var(--ch-border);
  font-family: var(--vscode-font-family); font-size: 11px; opacity: .8;
}
.ch-detail {
  position: absolute; inset: 10% 10% auto 10%; max-height: 70vh; overflow: auto;
  background: var(--vscode-editorWidget-background);
  border: 1px solid var(--vscode-focusBorder); box-shadow: 0 4px 16px rgba(0,0,0,.4);
}
.ch-detail-head {
  display: flex; justify-content: space-between; align-items: center;
  padding: 6px 10px; border-bottom: 1px solid var(--ch-border);
  font-family: var(--vscode-font-family); font-weight: 600;
}
.ch-detail-close { background: none; border: none; color: inherit; cursor: pointer; }
.ch-detail-body { margin: 0; padding: 10px; white-space: pre-wrap; word-break: break-word; }
`;
