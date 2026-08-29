/**
 * Tests for connection profiles, credentials and the status bar.
 */
import * as vscode from 'vscode';
import { ConnectionManager, interpolate, resolveProfile, validateProfiles } from '../client/connectionManager';

/** An extension context with an in-memory workspace state and secret store. */
function makeContext() {
    const state: Record<string, unknown> = {};
    const secrets = new Map<string, string>();
    return {
        context: {
            subscriptions: [],
            workspaceState: {
                get: (key: string, fallback?: unknown) => (key in state ? state[key] : fallback),
                update: async (key: string, value: unknown) => {
                    state[key] = value;
                },
            },
            secrets: {
                get: async (key: string) => secrets.get(key),
                store: async (key: string, value: string) => {
                    secrets.set(key, value);
                },
                delete: async (key: string) => {
                    secrets.delete(key);
                },
            },
        } as unknown as vscode.ExtensionContext,
        state,
        secrets,
    };
}

function setProfiles(profiles: unknown): void {
    (vscode as unknown as { __setConfig(v: Record<string, unknown>): void }).__setConfig({ connections: profiles });
}

beforeEach(() => {
    jest.clearAllMocks();
    (vscode as unknown as { __resetConfig(): void }).__resetConfig();
    (vscode.workspace as unknown as { isTrusted: boolean }).isTrusted = true;
});

describe('interpolate', () => {
    it('substitutes environment variables', () => {
        expect(interpolate('${env:HOST}', { HOST: 'ch.internal' })).toBe('ch.internal');
        expect(interpolate('pre-${env:A}-post', { A: 'x' })).toBe('pre-x-post');
    });

    it('substitutes an unset variable with nothing', () => {
        expect(interpolate('${env:MISSING}', {})).toBe('');
    });

    it('leaves plain text alone', () => {
        expect(interpolate('localhost', {})).toBe('localhost');
    });
});

describe('validateProfiles', () => {
    it('accepts a well-formed list', () => {
        const { profiles, issues } = validateProfiles([{ name: 'local', host: 'localhost' }]);
        expect(profiles).toHaveLength(1);
        expect(issues).toEqual([]);
    });

    it('accepts an absent setting', () => {
        expect(validateProfiles(undefined).profiles).toEqual([]);
    });

    it('rejects a non-array', () => {
        expect(validateProfiles({ name: 'x' }).issues).toHaveLength(1);
    });

    it('requires a name and a host', () => {
        expect(validateProfiles([{ host: 'h' }]).issues[0].message).toContain('name');
        expect(validateProfiles([{ name: 'n' }]).issues[0].message).toContain('host');
    });

    it('rejects a bad port or protocol', () => {
        expect(validateProfiles([{ name: 'n', host: 'h', port: 'x' }]).issues[0].message).toContain('port');
        expect(validateProfiles([{ name: 'n', host: 'h', protocol: 'ftp' }]).issues[0].message).toContain('protocol');
    });

    it('keeps the first of two profiles with the same name', () => {
        const { profiles, issues } = validateProfiles([
            { name: 'dup', host: 'a' },
            { name: 'dup', host: 'b' },
        ]);
        expect(profiles).toHaveLength(1);
        expect(profiles[0].host).toBe('a');
        expect(issues[0].message).toContain('Duplicate');
    });

    it('keeps the good profiles when one is bad', () => {
        const { profiles, issues } = validateProfiles([{ name: 'ok', host: 'h' }, { host: 'no name' }]);
        expect(profiles.map(p => p.name)).toEqual(['ok']);
        expect(issues).toHaveLength(1);
    });
});

describe('resolveProfile', () => {
    it('applies defaults', () => {
        expect(resolveProfile({ name: 'p', host: 'localhost' })).toMatchObject({
            url: 'http://localhost:8123',
            user: 'default',
            database: 'default',
            allowWrite: false,
            isProtected: false,
        });
    });

    it('defaults the port from the protocol', () => {
        expect(resolveProfile({ name: 'p', host: 'h', protocol: 'https' }).url).toBe('https://h:8443');
        expect(resolveProfile({ name: 'p', host: 'h', protocol: 'http' }).url).toBe('http://h:8123');
    });

    it('honours an explicit port', () => {
        expect(resolveProfile({ name: 'p', host: 'h', port: 9000 }).url).toBe('http://h:9000');
    });

    it('is read-only unless the profile opts in', () => {
        expect(resolveProfile({ name: 'p', host: 'h' }).allowWrite).toBe(false);
        expect(resolveProfile({ name: 'p', host: 'h', allowWrite: false }).allowWrite).toBe(false);
        expect(resolveProfile({ name: 'p', host: 'h', allowWrite: true }).allowWrite).toBe(true);
    });

    it('interpolates the environment into host, user and database', () => {
        const resolved = resolveProfile(
            { name: 'p', host: '${env:H}', user: '${env:U}', database: '${env:D}' },
            { H: 'host', U: 'user', D: 'db' }
        );
        expect(resolved.url).toBe('http://host:8123');
        expect(resolved.user).toBe('user');
        expect(resolved.database).toBe('db');
    });
});

describe('active profile', () => {
    it('is undefined with no profiles', () => {
        setProfiles([]);
        const { context } = makeContext();
        const manager = new ConnectionManager(context);
        expect(manager.activeProfileName()).toBeUndefined();
        manager.dispose();
    });

    it('picks the only profile without being asked', () => {
        setProfiles([{ name: 'solo', host: 'h' }]);
        const { context } = makeContext();
        const manager = new ConnectionManager(context);
        expect(manager.activeProfileName()).toBe('solo');
        manager.dispose();
    });

    it('needs a choice when there are several', () => {
        setProfiles([{ name: 'a', host: 'h' }, { name: 'b', host: 'h' }]);
        const { context } = makeContext();
        const manager = new ConnectionManager(context);
        expect(manager.activeProfileName()).toBeUndefined();
        manager.dispose();
    });

    it('remembers a choice', async () => {
        setProfiles([{ name: 'a', host: 'h' }, { name: 'b', host: 'h' }]);
        const { context } = makeContext();
        const manager = new ConnectionManager(context);
        await manager.setActiveProfile('b');
        expect(manager.activeProfileName()).toBe('b');
        manager.dispose();
    });

    it('forgets a choice that no longer exists', async () => {
        setProfiles([{ name: 'a', host: 'h' }, { name: 'gone', host: 'h' }]);
        const { context } = makeContext();
        const manager = new ConnectionManager(context);
        await manager.setActiveProfile('gone');
        setProfiles([{ name: 'a', host: 'h' }, { name: 'b', host: 'h' }]);
        expect(manager.activeProfileName()).toBeUndefined();
        manager.dispose();
    });

    it('announces a change', async () => {
        setProfiles([{ name: 'a', host: 'h' }, { name: 'b', host: 'h' }]);
        const { context } = makeContext();
        const manager = new ConnectionManager(context);
        const seen: Array<string | undefined> = [];
        manager.onDidChangeActiveProfile(name => seen.push(name));
        await manager.setActiveProfile('b');
        expect(seen).toEqual(['b']);
        manager.dispose();
    });
});

describe('credentials', () => {
    it('round-trips a password through secret storage', async () => {
        setProfiles([{ name: 'p', host: 'h' }]);
        const { context, secrets } = makeContext();
        const manager = new ConnectionManager(context);

        await manager.setPassword('p', 'hunter2');
        expect(await manager.getPassword('p')).toBe('hunter2');
        // Stored under a namespaced key, never in settings.
        expect([...secrets.keys()]).toEqual(['clickhouse.connection.p.password']);

        await manager.clearPassword('p');
        expect(await manager.getPassword('p')).toBeUndefined();
        manager.dispose();
    });

    it('attaches the password when resolving', async () => {
        setProfiles([{ name: 'p', host: 'h' }]);
        const { context } = makeContext();
        const manager = new ConnectionManager(context);
        await manager.setPassword('p', 'hunter2');
        expect((await manager.resolve())?.password).toBe('hunter2');
        manager.dispose();
    });
});

describe('workspace trust', () => {
    it('refuses to resolve in an untrusted workspace', async () => {
        setProfiles([{ name: 'p', host: 'h' }]);
        (vscode.workspace as unknown as { isTrusted: boolean }).isTrusted = false;
        const { context } = makeContext();
        const manager = new ConnectionManager(context);

        expect(await manager.resolve()).toBeUndefined();
        expect(await manager.client()).toBeUndefined();
        expect(vscode.window.showWarningMessage).toHaveBeenCalled();
        manager.dispose();
    });
});

describe('status bar', () => {
    function statusBar() {
        return (vscode.window.createStatusBarItem as jest.Mock).mock.results.at(-1)!.value;
    }

    it('offers to connect when there are no profiles', () => {
        setProfiles([]);
        const { context } = makeContext();
        const manager = new ConnectionManager(context);
        // The empty state must be an offer, not a statement of fact.
        expect(statusBar().text).toContain('connect');
        expect(statusBar().command).toBe('clickhouse.addConnection');
        manager.dispose();
    });

    it('switches the click target once a profile exists', () => {
        setProfiles([{ name: 'solo', host: 'h' }]);
        const { context } = makeContext();
        const manager = new ConnectionManager(context);
        expect(statusBar().command).toBe('clickhouse.selectConnection');
        manager.dispose();
    });

    it('names the active profile and marks it read-only', () => {
        setProfiles([{ name: 'prod', host: 'h' }]);
        const { context } = makeContext();
        const manager = new ConnectionManager(context);
        expect(statusBar().text).toContain('prod');
        expect(statusBar().text).toContain('read-only');
        manager.dispose();
    });

    it('does not say read-only for a writable profile', () => {
        setProfiles([{ name: 'local', host: 'h', allowWrite: true }]);
        const { context } = makeContext();
        const manager = new ConnectionManager(context);
        expect(statusBar().text).not.toContain('read-only');
        manager.dispose();
    });

    it('colours a protected profile', () => {
        setProfiles([{ name: 'prod', host: 'h', allowWrite: true, protected: true }]);
        const { context } = makeContext();
        const manager = new ConnectionManager(context);
        expect(statusBar().text).toContain('protected');
        expect(statusBar().backgroundColor).toBeDefined();
        manager.dispose();
    });

    it('asks for a choice when several profiles exist', () => {
        setProfiles([{ name: 'a', host: 'h' }, { name: 'b', host: 'h' }]);
        const { context } = makeContext();
        const manager = new ConnectionManager(context);
        expect(statusBar().text).toContain('select connection');
        manager.dispose();
    });
});

describe('choosing a profile', () => {
    it('does not interrupt when there is only one', async () => {
        // Test Connection, Set Password and friends have nothing to ask about.
        setProfiles([{ name: 'solo', host: 'h' }]);
        const { context } = makeContext();
        const manager = new ConnectionManager(context);

        await vscode.commands.executeCommand('clickhouse.testConnection');
        expect(manager.activeProfileName()).toBe('solo');
        manager.dispose();
    });
});
