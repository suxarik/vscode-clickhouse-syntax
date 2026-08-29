/**
 * Keeping the live schema in step with the server.
 *
 * Introspection is cached to disk per profile, so opening a workspace does not
 * re-read a thousand tables. The cache is only ever a starting point: a stale
 * entry is used immediately and refreshed in the background, because a schema
 * that is a few minutes old is far better than no completions at all.
 */
import * as vscode from 'vscode';
import { SchemaManager } from '../schemaManager';
import { AnalysisCache } from '../analysis';
import { ConnectionManager } from './connectionManager';
import { countColumns, countTables, introspect, LiveSchema } from './introspection';

const CACHE_DIRECTORY = 'schema-cache';

/** Profile names are used as filenames, so keep them to something safe. */
export function cacheFileName(profile: string): string {
    const safe = profile.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
    // Two profiles differing only in stripped characters must not collide.
    let hash = 0;
    for (let i = 0; i < profile.length; i++) hash = (hash * 31 + profile.charCodeAt(i)) | 0;
    return `${safe}.${(hash >>> 0).toString(16)}.json`;
}

export function isStale(schema: LiveSchema, ttlMinutes: number): boolean {
    if (ttlMinutes <= 0) return false;
    return Date.now() - schema.fetchedAt > ttlMinutes * 60_000;
}

export interface SchemaFreshness {
    /** What is loaded came off disk rather than from the server. */
    fromCache: boolean;
    /** A refresh is in flight right now. */
    refreshing: boolean;
    /** When the loaded schema was read from a server. */
    fetchedAt?: number;
    /** Why the last attempt to refresh failed, if it did. */
    lastError?: string;
}

export class SchemaSync implements vscode.Disposable {
    private readonly disposables: vscode.Disposable[] = [];
    private inFlight: Promise<LiveSchema | undefined> | undefined;
    private freshness: SchemaFreshness = { fromCache: false, refreshing: false };
    private readonly freshnessChanged = new vscode.EventEmitter<SchemaFreshness>();

    /** Fires when the schema becomes stale, or stops being stale. */
    readonly onDidChangeFreshness = this.freshnessChanged.event;

    /**
     * Whether what is on screen reflects the server.
     *
     * A cached schema that cannot be refreshed looks exactly like a working
     * connection, which hides a broken one. Callers surface this.
     */
    getFreshness(): SchemaFreshness {
        return this.freshness;
    }

    private setFreshness(next: SchemaFreshness): void {
        this.freshness = next;
        this.freshnessChanged.fire(next);
    }

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly connections: ConnectionManager,
        private readonly schemaManager: SchemaManager,
        private readonly analysisCache: AnalysisCache
    ) {
        this.disposables.push(
            // Switching profile switches schema; the two must never disagree.
            this.connections.onDidChangeActiveProfile(() => void this.onProfileChanged())
        );
    }

    private get ttlMinutes(): number {
        return vscode.workspace.getConfiguration('clickhouse').get<number>('schema.cacheTtlMinutes', 60);
    }

    private get enabled(): boolean {
        const config = vscode.workspace.getConfiguration('clickhouse');
        if (!config.get<boolean>('schema.enabled', true)) return false;
        return config.get<string>('schema.source', 'both') !== 'file';
    }

    private cacheUri(profile: string): vscode.Uri {
        return vscode.Uri.joinPath(this.context.globalStorageUri, CACHE_DIRECTORY, cacheFileName(profile));
    }

    private async readCache(profile: string): Promise<LiveSchema | undefined> {
        try {
            const bytes = await vscode.workspace.fs.readFile(this.cacheUri(profile));
            const parsed = JSON.parse(new TextDecoder().decode(bytes)) as LiveSchema;
            return Array.isArray(parsed.databases) ? parsed : undefined;
        } catch {
            return undefined;
        }
    }

    private async writeCache(schema: LiveSchema): Promise<void> {
        try {
            const uri = this.cacheUri(schema.profile);
            await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
            await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(JSON.stringify(schema)));
        } catch (error) {
            console.error('ClickHouse: could not cache the schema', error);
        }
    }

    private apply(schema: LiveSchema | null): void {
        this.schemaManager.setLiveSchema(schema);
        // Cached analyses were bound against the previous columns.
        this.analysisCache.invalidate();
    }

    /** Load from cache if we have one, then refresh when it is stale. */
    async activate(): Promise<void> {
        if (!this.enabled) return;
        const profile = this.connections.activeProfileName();
        if (!profile) return;

        const cached = await this.readCache(profile);
        if (cached) {
            this.apply(cached);
            const stale = isStale(cached, this.ttlMinutes);
            // Only claim to be refreshing when one is actually about to run,
            // or the notice never goes away.
            this.setFreshness({ fromCache: true, refreshing: stale, fetchedAt: cached.fetchedAt });
            if (!stale) return;
        }
        void this.refresh({ silent: true });
    }

    private async onProfileChanged(): Promise<void> {
        const profile = this.connections.activeProfileName();
        if (!profile) {
            this.apply(null);
            return;
        }
        // Never leave another profile's schema in place while the new one loads.
        this.apply(null);
        await this.activate();
    }

    /** Re-read the schema from the server. */
    async refresh(options: { silent?: boolean } = {}): Promise<LiveSchema | undefined> {
        if (this.inFlight) return this.inFlight;

        this.inFlight = this.doRefresh(options).finally(() => {
            this.inFlight = undefined;
        });
        return this.inFlight;
    }

    private async doRefresh(options: { silent?: boolean }): Promise<LiveSchema | undefined> {
        this.setFreshness({ ...this.freshness, refreshing: true });
        const profile = this.connections.activeProfileName();
        if (!profile) {
            this.setFreshness({ ...this.freshness, refreshing: false });
            if (!options.silent) {
                vscode.window.showWarningMessage('ClickHouse: no connection selected, so there is no schema to read.');
            }
            return undefined;
        }

        const client = await this.connections.client(profile);
        if (!client) {
            this.setFreshness({ ...this.freshness, refreshing: false });
            return undefined;
        }

        const config = vscode.workspace.getConfiguration('clickhouse');
        const run = async () => {
            const schema = await introspect(client, profile, {
                includeSystem: config.get<boolean>('schema.includeSystemDatabase', false),
                maxTables: config.get<number>('schema.maxTables', 20000),
            });
            this.apply(schema);
            this.setFreshness({ fromCache: false, refreshing: false, fetchedAt: schema.fetchedAt });
            await this.writeCache(schema);
            return schema;
        };

        try {
            const schema = options.silent
                ? await run()
                : await vscode.window.withProgress(
                      {
                          location: vscode.ProgressLocation.Window,
                          title: `ClickHouse: reading schema from '${profile}'`,
                      },
                      run
                  );

            if (!options.silent) {
                vscode.window.showInformationMessage(
                    `ClickHouse: ${countTables(schema)} table(s), ${countColumns(schema)} column(s) from '${profile}'.`
                );
            }
            return schema;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            // Record the failure even when it was a background attempt, so a
            // stale schema can never pass itself off as a working connection.
            this.setFreshness({ ...this.freshness, refreshing: false, lastError: message });
            if (!options.silent) {
                vscode.window.showErrorMessage(`ClickHouse: could not read the schema - ${message}`);
            } else {
                console.error('ClickHouse: background schema refresh failed', error);
            }
            return undefined;
        }
    }

    /** Forget the cached schema for every profile. */
    async clearCache(): Promise<void> {
        try {
            await vscode.workspace.fs.delete(
                vscode.Uri.joinPath(this.context.globalStorageUri, CACHE_DIRECTORY),
                { recursive: true, useTrash: false }
            );
        } catch {
            // Nothing cached yet.
        }
        this.apply(null);
        this.setFreshness({ fromCache: false, refreshing: false });
    }

    dispose(): void {
        this.freshnessChanged.dispose();
        for (const disposable of this.disposables) disposable.dispose();
        this.disposables.length = 0;
    }
}
