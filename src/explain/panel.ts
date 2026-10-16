/**
 * The plan panel.
 *
 * Owns the webview and everything the webview must not do: reading the
 * connection, running the query, and writing files. The view receives a graph
 * and sends back an image; it never touches the disk or the server.
 */
import * as vscode from 'vscode';
import { PlanHostMessage, PlanPayload, PlanViewMessage, ImageFormat } from './protocol';
import { PLAN_STYLE } from './view/planStyle';

const EXTENSIONS: Record<ImageFormat, string> = { svg: 'svg', png: 'png', jpg: 'jpg' };

export class PlanPanel implements vscode.Disposable {
    private panel?: vscode.WebviewPanel;
    private ready = false;
    private queued: PlanHostMessage[] = [];

    constructor(private readonly extensionUri: vscode.Uri) {}

    /** Open the panel, or bring the existing one forward. */
    show(title: string): void {
        if (this.panel) {
            this.panel.title = title;
            this.panel.reveal(vscode.ViewColumn.Beside, true);
            return;
        }

        this.panel = vscode.window.createWebviewPanel(
            'clickhousePlan',
            title,
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')],
            }
        );
        this.panel.webview.html = this.html(this.panel.webview);
        this.panel.webview.onDidReceiveMessage((message: PlanViewMessage) => void this.onViewMessage(message));
        this.panel.onDidDispose(() => {
            this.panel = undefined;
            this.ready = false;
            this.queued = [];
        });
    }

    post(message: PlanHostMessage): void {
        if (!this.panel) return;
        if (!this.ready) {
            this.queued.push(message);
            return;
        }
        void this.panel.webview.postMessage(message);
    }

    showPlan(payload: PlanPayload): void {
        this.post({ type: 'plan', payload });
    }

    private async onViewMessage(message: PlanViewMessage): Promise<void> {
        if (message.type === 'ready') {
            this.ready = true;
            const queued = this.queued;
            this.queued = [];
            for (const pending of queued) void this.panel?.webview.postMessage(pending);
            return;
        }
        if (message.type === 'export') await this.save(message.format, message.data);
    }

    private async save(format: ImageFormat, data: string): Promise<void> {
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        const target = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(`clickhouse-plan-${stamp}.${EXTENSIONS[format]}`),
            filters: { [format.toUpperCase()]: [EXTENSIONS[format]] },
        });
        if (!target) return;

        // SVG arrives as markup; the raster formats arrive as a data URL.
        const bytes =
            format === 'svg'
                ? Buffer.from(data, 'utf8')
                : Buffer.from(data.slice(data.indexOf(',') + 1), 'base64');

        await vscode.workspace.fs.writeFile(target, bytes);
        vscode.window.setStatusBarMessage(`ClickHouse: plan saved as ${format.toUpperCase()}`, 3000);
    }

    private html(webview: vscode.Webview): string {
        const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'plan.js'));
        const nonce = Math.random().toString(36).slice(2);
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>${PLAN_STYLE}</style>
</head>
<body><div id="root"></div><script nonce="${nonce}" src="${script}"></script></body>
</html>`;
    }

    dispose(): void {
        this.panel?.dispose();
    }
}
