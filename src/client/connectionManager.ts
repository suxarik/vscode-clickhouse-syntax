/**
 * Connection profiles and the credentials that go with them.
 *
 * Profiles live in settings; passwords live in `SecretStorage` and never touch a
 * file the workspace could commit. The active profile is always named in the
 * status bar, so it is never a guess which server a query is about to hit.
 */
import * as vscode from 'vscode';
import { ClickHouseClient } from './httpClient';
import { ConnectionProfile, ResolvedConnection } from './types';

const ACTIVE_PROFILE_KEY = 'clickhouse.connection.active';
const SECRET_PREFIX = 'clickhouse.connection.';

function secretKey(name: string): string {
    return `${SECRET_PREFIX}${name}.password`;
}

/** `${env:NAME}` → the environment variable, or an empty string. */
export function interpolate(value: string, env: Record<string, string | undefined>): string {
    return value.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => env[name] ?? '');
}

export interface ProfileIssue {
    profile: string;
    message: string;
}

/** Validate the shape of `clickhouse.connections`. */
export function validateProfiles(raw: unknown): { profiles: ConnectionProfile[]; issues: ProfileIssue[] } {
    const issues: ProfileIssue[] = [];
    if (raw === undefined || raw === null) return { profiles: [], issues };
    if (!Array.isArray(raw)) {
        return { profiles: [], issues: [{ profile: '', message: '"clickhouse.connections" must be an array' }] };
    }

    const profiles: ConnectionProfile[] = [];
    const seen = new Set<string>();

    raw.forEach((entry, index) => {
        const label = `connections[${index}]`;
        if (!entry || typeof entry !== 'object') {
            issues.push({ profile: label, message: 'Profile must be an object' });
            return;
        }
        const candidate = entry as Record<string, unknown>;
        const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
        if (!name) {
            issues.push({ profile: label, message: 'Profile requires a non-empty "name"' });
            return;
        }
        if (seen.has(name.toLowerCase())) {
            issues.push({ profile: name, message: 'Duplicate profile name; the first one is kept' });
            return;
        }
        if (typeof candidate.host !== 'string' || !candidate.host.trim()) {
            issues.push({ profile: name, message: 'Profile requires a non-empty "host"' });
            return;
        }
        if (candidate.port !== undefined && typeof candidate.port !== 'number') {
            issues.push({ profile: name, message: '"port" must be a number' });
            return;
        }
        if (candidate.protocol !== undefined && candidate.protocol !== 'http' && candidate.protocol !== 'https') {
            issues.push({ profile: name, message: '"protocol" must be "http" or "https"' });
            return;
        }
        seen.add(name.toLowerCase());
        profiles.push(entry as ConnectionProfile);
    });

    return { profiles, issues };
}

/** Apply defaults and environment interpolation. Credentials are added later. */
export function resolveProfile(
    profile: ConnectionProfile,
    env: Record<string, string | undefined> = {}
): Omit<ResolvedConnection, 'password'> {
    const protocol = profile.protocol ?? 'http';
    const host = interpolate(profile.host, env);
    const port = profile.port ?? (protocol === 'https' ? 8443 : 8123);
    return {
        name: profile.name,
        url: `${protocol}://${host}:${port}`,
        user: interpolate(profile.user ?? 'default', env),
        database: interpolate(profile.database ?? 'default', env),
        // Read-only unless the profile opts in. This is the default that matters.
        allowWrite: profile.allowWrite === true,
        isProtected: profile.protected === true,
        auth: profile.auth === 'token' ? 'token' : 'password',
        allowInvalidCertificate: profile.allowInvalidCertificate === true,
        settings: profile.settings ?? {},
    };
}

export interface ProfileTestResult {
    ok: boolean;
    /** One line suitable for a notification. */
    description: string;
}

export class ConnectionManager implements vscode.Disposable {
    private readonly statusBar: vscode.StatusBarItem;
    private readonly disposables: vscode.Disposable[] = [];
    private readonly onDidChangeEmitter = new vscode.EventEmitter<string | undefined>();

    /** Fires with the new active profile name, or undefined when disconnected. */
    readonly onDidChangeActiveProfile = this.onDidChangeEmitter.event;

    constructor(private readonly context: vscode.ExtensionContext) {
        this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
        this.statusBar.command = 'clickhouse.selectConnection';
        this.disposables.push(this.statusBar, this.onDidChangeEmitter);

        this.disposables.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('clickhouse.connections')) {
                    this.updateStatusBar();
                    void this.publishContext();
                }
            })
        );
        this.updateStatusBar();
        void this.publishContext();
    }

    /**
     * Context keys drive the tree's welcome content, which is what turns an
     * empty explorer from a dead end into an offer to connect.
     */
    private async publishContext(): Promise<void> {
        const profiles = this.profiles();
        await vscode.commands.executeCommand('setContext', 'clickhouse.hasConnections', profiles.length > 0);
        await vscode.commands.executeCommand(
            'setContext',
            'clickhouse.hasActiveConnection',
            this.activeProfileName() !== undefined
        );
    }

    profiles(): ConnectionProfile[] {
        const raw = vscode.workspace.getConfiguration('clickhouse').get<unknown>('connections', []);
        return validateProfiles(raw).profiles;
    }

    issues(): ProfileIssue[] {
        const raw = vscode.workspace.getConfiguration('clickhouse').get<unknown>('connections', []);
        return validateProfiles(raw).issues;
    }

    activeProfileName(): string | undefined {
        const stored = this.context.workspaceState.get<string>(ACTIVE_PROFILE_KEY);
        const available = this.profiles();
        if (stored && available.some(profile => profile.name === stored)) return stored;
        // A single profile needs no picking.
        return available.length === 1 ? available[0].name : undefined;
    }

    activeProfile(): ConnectionProfile | undefined {
        const name = this.activeProfileName();
        return name ? this.profiles().find(profile => profile.name === name) : undefined;
    }

    async setActiveProfile(name: string | undefined): Promise<void> {
        await this.context.workspaceState.update(ACTIVE_PROFILE_KEY, name);
        this.updateStatusBar();
        await this.publishContext();
        this.onDidChangeEmitter.fire(name);
    }

    /** Connect and report what came back, for the setup flow and Test Connection. */
    async testProfile(name: string): Promise<ProfileTestResult> {
        const client = await this.client(name);
        if (!client) return { ok: false, description: 'the profile could not be resolved' };
        try {
            const result = await client.query('SELECT version(), currentUser(), currentDatabase()', {
                readOnly: true,
                maxExecutionTime: 15,
            });
            const [version, user, database] = result.rows[0] ?? [];
            return { ok: true, description: `v${version} as ${user}, database ${database}` };
        } catch (error) {
            return { ok: false, description: error instanceof Error ? error.message : String(error) };
        }
    }

    // ── Credentials ──────────────────────────────────────────────────────────

    async getPassword(name: string): Promise<string | undefined> {
        return this.context.secrets.get(secretKey(name));
    }

    async setPassword(name: string, password: string): Promise<void> {
        await this.context.secrets.store(secretKey(name), password);
    }

    async clearPassword(name: string): Promise<void> {
        await this.context.secrets.delete(secretKey(name));
    }

    /**
     * Resolve a profile into something connectable.
     *
     * Refuses in an untrusted workspace: profiles come from workspace settings,
     * so honouring them there would let a repository point the extension at a
     * host of its choosing.
     */
    async resolve(name?: string): Promise<ResolvedConnection | undefined> {
        if (!vscode.workspace.isTrusted) {
            vscode.window.showWarningMessage(
                'ClickHouse: connections are disabled in restricted mode. Trust the workspace to connect.'
            );
            return undefined;
        }

        const profileName = name ?? this.activeProfileName();
        if (!profileName) return undefined;
        const profile = this.profiles().find(entry => entry.name === profileName);
        if (!profile) return undefined;

        const resolved = resolveProfile(profile, process.env);
        return { ...resolved, password: await this.getPassword(profile.name) };
    }

    /** A client for the active profile, or undefined when there is none. */
    async client(name?: string): Promise<ClickHouseClient | undefined> {
        const connection = await this.resolve(name);
        return connection ? new ClickHouseClient(connection) : undefined;
    }

    // ── Status bar ───────────────────────────────────────────────────────────

    updateStatusBar(): void {
        const profiles = this.profiles();
        if (profiles.length === 0) {
            this.statusBar.text = '$(plug) ClickHouse: connect';
            this.statusBar.tooltip = 'No ClickHouse connection yet. Click to add one.';
            this.statusBar.command = 'clickhouse.addConnection';
            this.statusBar.backgroundColor = undefined;
            this.statusBar.show();
            return;
        }
        this.statusBar.command = 'clickhouse.selectConnection';

        const active = this.activeProfile();
        if (!active) {
            this.statusBar.text = '$(plug) ClickHouse: select connection';
            this.statusBar.tooltip = 'Choose which server queries run against.';
            this.statusBar.backgroundColor = undefined;
            this.statusBar.show();
            return;
        }

        const marks: string[] = [];
        if (active.protected === true) marks.push('protected');
        if (active.allowWrite !== true) marks.push('read-only');

        this.statusBar.text = `$(database) ${active.name}${marks.length ? ` (${marks.join(', ')})` : ''}`;
        this.statusBar.tooltip = [
            `ClickHouse: ${active.name}`,
            `${active.protocol ?? 'http'}://${active.host}:${active.port ?? 8123}`,
            `Database: ${active.database ?? 'default'}`,
            active.allowWrite === true ? 'Writes are permitted' : 'Read-only',
            active.protected === true ? 'Protected: writes need typed confirmation' : '',
            '',
            'Click to switch profile.',
        ]
            .filter(Boolean)
            .join('\n');
        // A protected profile is worth colouring, so it is obvious at a glance.
        this.statusBar.backgroundColor =
            active.protected === true
                ? new vscode.ThemeColor('statusBarItem.warningBackground')
                : undefined;
        this.statusBar.show();
    }

    dispose(): void {
        for (const disposable of this.disposables) disposable.dispose();
        this.disposables.length = 0;
    }
}
