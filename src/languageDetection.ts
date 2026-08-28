/**
 * ClickHouse dialect detection for open documents.
 *
 * Detection never silently rewrites a document's language unless the user has
 * asked for that: `clickhouse.detect.mode` defaults to `prompt`, decisions are
 * remembered per file, and the current state is always visible in the status bar.
 */
import * as vscode from 'vscode';
import { isClickHouseSQL } from './sqlContext';

type DetectMode = 'off' | 'prompt' | 'auto';
type Decision = 'accepted' | 'declined';

const DECISIONS_KEY = 'clickhouse.detect.decisions';

export class LanguageDetector implements vscode.Disposable {
    private readonly statusBar: vscode.StatusBarItem;
    private readonly disposables: vscode.Disposable[] = [];
    private readonly pending = new Set<string>();

    constructor(private readonly context: vscode.ExtensionContext) {
        this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.statusBar.command = 'clickhouse.toggleLanguage';
        this.disposables.push(this.statusBar);

        this.disposables.push(
            vscode.window.onDidChangeActiveTextEditor(() => this.updateStatusBar()),
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('clickhouse.detect')) this.updateStatusBar();
            })
        );
        this.updateStatusBar();
    }

    private get mode(): DetectMode {
        return vscode.workspace.getConfiguration('clickhouse').get<DetectMode>('detect.mode', 'prompt');
    }

    private get includePlaintext(): boolean {
        return vscode.workspace.getConfiguration('clickhouse').get<boolean>('detect.includePlaintext', false);
    }

    private decisions(): Record<string, Decision> {
        return this.context.workspaceState.get<Record<string, Decision>>(DECISIONS_KEY, {});
    }

    private async remember(uri: vscode.Uri, decision: Decision): Promise<void> {
        const decisions = { ...this.decisions(), [uri.toString()]: decision };
        await this.context.workspaceState.update(DECISIONS_KEY, decisions);
    }

    /** Languages detection is allowed to convert from. */
    private isCandidate(document: vscode.TextDocument): boolean {
        if (document.languageId === 'clickhouse') return false;
        if (document.uri.scheme !== 'file') return false;
        if (document.languageId === 'sql') return true;
        return document.languageId === 'plaintext' && this.includePlaintext;
    }

    /**
     * Offer — or, in `auto` mode, perform — the switch to ClickHouse SQL.
     */
    async consider(document: vscode.TextDocument): Promise<void> {
        const mode = this.mode;
        if (mode === 'off') return;
        if (!this.isCandidate(document)) return;

        const key = document.uri.toString();
        if (this.pending.has(key)) return;
        if (this.decisions()[key] === 'declined') return;
        if (!isClickHouseSQL(document.getText())) return;

        if (mode === 'auto' || this.decisions()[key] === 'accepted') {
            await this.apply(document);
            return;
        }

        this.pending.add(key);
        try {
            const choice = await vscode.window.showInformationMessage(
                `"${basename(document.uri)}" looks like ClickHouse SQL. Switch the language mode?`,
                'Switch',
                'Not this file',
                'Never ask'
            );
            if (choice === 'Switch') {
                await this.remember(document.uri, 'accepted');
                await this.apply(document);
            } else if (choice === 'Not this file') {
                await this.remember(document.uri, 'declined');
            } else if (choice === 'Never ask') {
                await vscode.workspace
                    .getConfiguration('clickhouse')
                    .update('detect.mode', 'off', vscode.ConfigurationTarget.Global);
            }
        } finally {
            this.pending.delete(key);
        }
    }

    private async apply(document: vscode.TextDocument): Promise<void> {
        try {
            await vscode.languages.setTextDocumentLanguage(document, 'clickhouse');
            this.updateStatusBar();
        } catch {
            // The document may have closed in the meantime; nothing to do.
        }
    }

    /** Explicit user request — always acts, never prompts. */
    async detectExplicitly(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('ClickHouse: no active editor.');
            return;
        }
        const document = editor.document;
        if (document.languageId === 'clickhouse') {
            vscode.window.showInformationMessage('ClickHouse: this file is already in ClickHouse SQL mode.');
            return;
        }
        if (!isClickHouseSQL(document.getText())) {
            const choice = await vscode.window.showWarningMessage(
                'No ClickHouse-specific syntax detected in this file. Switch anyway?',
                'Switch anyway'
            );
            if (choice !== 'Switch anyway') return;
        }
        await this.remember(document.uri, 'accepted');
        await this.apply(document);
    }

    /** Flip the active document between ClickHouse SQL and plain SQL. */
    async toggleLanguage(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        const document = editor.document;
        if (document.languageId === 'clickhouse') {
            await this.remember(document.uri, 'declined');
            await vscode.languages.setTextDocumentLanguage(document, 'sql');
        } else {
            await this.remember(document.uri, 'accepted');
            await this.apply(document);
        }
        this.updateStatusBar();
    }

    updateStatusBar(): void {
        const editor = vscode.window.activeTextEditor;
        const languageId = editor?.document.languageId;
        if (languageId === 'clickhouse') {
            this.statusBar.text = '$(database) ClickHouse SQL';
            this.statusBar.tooltip = 'ClickHouse SQL mode is active. Click to switch back to plain SQL.';
            this.statusBar.show();
        } else if (languageId === 'sql') {
            this.statusBar.text = '$(database) SQL';
            this.statusBar.tooltip = 'Click to switch this file to ClickHouse SQL.';
            this.statusBar.show();
        } else {
            this.statusBar.hide();
        }
    }

    dispose(): void {
        for (const d of this.disposables) d.dispose();
        this.disposables.length = 0;
    }
}

function basename(uri: vscode.Uri): string {
    const parts = uri.path.split('/');
    return parts[parts.length - 1] || uri.path;
}
