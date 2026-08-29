/**
 * Finding the dbt project in the workspace, and keeping its manifest current.
 *
 * dbt rewrites `target/manifest.json` on every compile, so this watches the
 * file rather than reading it once: a model added five minutes ago should turn
 * up in completions without a reload.
 *
 * Everything here is best-effort. No dbt project, no manifest, or a manifest
 * caught half-written all end the same way - `ref()` stays opaque, which is
 * what the parser already handles.
 */
import * as vscode from 'vscode';
import { clickHouseName, DbtManifest, parseManifest } from './manifest';

/** Where dbt puts the compiled manifest, relative to the project root. */
const MANIFEST_GLOB = '**/target/manifest.json';
const PROJECT_GLOB = '**/dbt_project.yml';

export class DbtProject implements vscode.Disposable {
    private manifest: DbtManifest | undefined;
    private watcher: vscode.FileSystemWatcher | undefined;
    private readonly changed = new vscode.EventEmitter<void>();

    /** Fires when the manifest is loaded or reloaded, so caches can clear. */
    readonly onDidChange = this.changed.event;

    async load(): Promise<void> {
        // Workspace settings decide what gets read, so an untrusted folder gets
        // nothing - the same rule connections follow.
        if (!vscode.workspace.isTrusted) return;
        if (!vscode.workspace.workspaceFolders?.length) return;

        const [found] = await vscode.workspace.findFiles(MANIFEST_GLOB, '**/node_modules/**', 1);
        if (found) await this.read(found);

        if (!this.watcher) {
            this.watcher = vscode.workspace.createFileSystemWatcher(MANIFEST_GLOB);
            this.watcher.onDidCreate(uri => void this.read(uri));
            this.watcher.onDidChange(uri => void this.read(uri));
            this.watcher.onDidDelete(() => {
                this.manifest = undefined;
                this.changed.fire();
            });
        }
    }

    private async read(uri: vscode.Uri): Promise<void> {
        try {
            const parsed = parseManifest(await vscode.workspace.fs.readFile(uri));
            // A manifest that failed to parse is kept out rather than replacing
            // a good one: dbt may simply have been mid-write.
            if (!parsed) return;
            this.manifest = parsed;
            this.changed.fire();
        } catch {
            // Unreadable is the same as absent.
        }
    }

    /** Whether a dbt project is present at all, manifest or not. */
    static async isPresent(): Promise<boolean> {
        if (!vscode.workspace.workspaceFolders?.length) return false;
        const [found] = await vscode.workspace.findFiles(PROJECT_GLOB, '**/node_modules/**', 1);
        return found !== undefined;
    }

    resolve(call: 'ref' | 'source', args: string[]): { database?: string; table: string } | undefined {
        const relation = this.manifest?.resolve(call, args);
        return relation ? clickHouseName(relation) : undefined;
    }

    modelNames(): string[] {
        return this.manifest?.modelNames() ?? [];
    }

    sourceNames(): string[] {
        return this.manifest?.sourceNames() ?? [];
    }

    get loaded(): boolean {
        return this.manifest !== undefined;
    }

    get size(): number {
        return this.manifest?.size ?? 0;
    }

    dispose(): void {
        this.watcher?.dispose();
        this.changed.dispose();
    }
}
