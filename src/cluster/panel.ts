/**
 * The cluster panel.
 *
 * Same shape as the plan panel, and the same division of labour: the webview
 * draws and makes images, the host reads the server and writes files.
 */
import * as vscode from 'vscode';
import { ClusterHostMessage, ClusterPayload, ClusterViewMessage } from './protocol';
import { PLAN_STYLE } from '../explain/view/planStyle';
import { CLUSTER_STYLE } from './view/clusterStyle';

export class ClusterPanel implements vscode.Disposable {
    private panel?: vscode.WebviewPanel;
    private ready = false;
    private queued: ClusterHostMessage[] = [];

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly onRefresh: () => void
    ) {}

    show(title: string): void {
        if (this.panel) {
            this.panel.title = title;
            this.panel.reveal(vscode.ViewColumn.Active, false);
            return;
        }

        this.panel = vscode.window.createWebviewPanel(
            'clickhouseCluster',
            title,
            { viewColumn: vscode.ViewColumn.Active },
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')],
            }
        );
        this.panel.webview.html = this.html(this.panel.webview);
        this.panel.webview.onDidReceiveMessage((message: ClusterViewMessage) => void this.onMessage(message));
        this.panel.onDidDispose(() => {
            this.panel = undefined;
            this.ready = false;
            this.queued = [];
        });
    }

    post(message: ClusterHostMessage): void {
        if (!this.panel) return;
        if (!this.ready) {
            this.queued.push(message);
            return;
        }
        void this.panel.webview.postMessage(message);
    }

    showCluster(payload: ClusterPayload): void {
        this.post({ type: 'cluster', payload });
    }

    private async onMessage(message: ClusterViewMessage): Promise<void> {
        if (message.type === 'ready') {
            this.ready = true;
            const queued = this.queued;
            this.queued = [];
            for (const pending of queued) void this.panel?.webview.postMessage(pending);
            return;
        }
        if (message.type === 'refresh') {
            this.onRefresh();
            return;
        }

        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        const target = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(`clickhouse-cluster-${stamp}.${message.format}`),
            filters: { [message.format.toUpperCase()]: [message.format] },
        });
        if (!target) return;

        const bytes =
            message.format === 'svg'
                ? Buffer.from(message.data, 'utf8')
                : Buffer.from(message.data.slice(message.data.indexOf(',') + 1), 'base64');
        await vscode.workspace.fs.writeFile(target, bytes);
        vscode.window.setStatusBarMessage(`ClickHouse: cluster saved as ${message.format.toUpperCase()}`, 3000);
    }

    private html(webview: vscode.Webview): string {
        const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'cluster.js'));
        const nonce = Math.random().toString(36).slice(2);
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>${PLAN_STYLE}${CLUSTER_STYLE}</style>
</head>
<body><div id="root"></div><script nonce="${nonce}" src="${script}"></script></body>
</html>`;
    }

    dispose(): void {
        this.panel?.dispose();
    }
}
