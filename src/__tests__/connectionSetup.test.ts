/**
 * Tests for the guided connection setup.
 *
 * The flow tests drive the whole question sequence, because the bugs that
 * reached users here were never in a single function - they were in what the
 * answers add up to: a profile written to the wrong settings file, a password
 * left behind by a rename, an edit that silently did nothing.
 */
import * as vscode from 'vscode';
import { parseTarget, registerConnectionSetupCommands, suggestName } from '../client/connectionSetup';
import { ConnectionManager } from '../client/connectionManager';
import { ConnectionProfile } from '../client/types';

describe('parseTarget', () => {
    it('accepts a bare host', () => {
        expect(parseTarget('localhost')).toEqual({ protocol: 'http', host: 'localhost', port: 8123 });
    });

    it('accepts host:port', () => {
        expect(parseTarget('ch.internal:9000')).toEqual({
            protocol: 'http',
            host: 'ch.internal',
            port: 9000,
        });
    });

    it('accepts a full URL', () => {
        expect(parseTarget('https://abc.clickhouse.cloud:8443')).toEqual({
            protocol: 'https',
            host: 'abc.clickhouse.cloud',
            port: 8443,
        });
    });

    it('defaults the port from the scheme', () => {
        // ClickHouse Cloud hands out URLs with no port.
        expect(parseTarget('https://abc.clickhouse.cloud')?.port).toBe(8443);
        expect(parseTarget('http://ch.internal')?.port).toBe(8123);
    });

    it('ignores a path someone pasted along with the host', () => {
        expect(parseTarget('https://ch.internal:8443/play')?.host).toBe('ch.internal');
    });

    it('rejects nonsense', () => {
        expect(parseTarget('')).toBeUndefined();
        expect(parseTarget('   ')).toBeUndefined();
        expect(parseTarget('http://')).toBeUndefined();
    });
});

describe('suggestName', () => {
    it('calls localhost "local"', () => {
        expect(suggestName('localhost', [])).toBe('local');
        expect(suggestName('127.0.0.1', [])).toBe('local');
    });

    it('uses the first label of a hostname', () => {
        expect(suggestName('warehouse.eu.internal', [])).toBe('warehouse');
    });

    it('avoids a name already taken', () => {
        expect(suggestName('localhost', ['local'])).toBe('local-2');
        expect(suggestName('localhost', ['local', 'local-2'])).toBe('local-3');
    });
});

describe('editConnection arguments', () => {
    /** Mirrors how the command decides whether it was given a profile name. */
    function resolvePreselection(preselected: unknown, profiles: string[]): string | undefined {
        return typeof preselected === 'string' && profiles.includes(preselected) ? preselected : undefined;
    }

    const profiles = ['local', 'prod'];

    it('accepts a known profile name', () => {
        expect(resolvePreselection('prod', profiles)).toBe('prod');
    });

    it('ignores the context object a menu passes', () => {
        // This is what made the command appear to do nothing: a truthy object
        // was taken for a name, matched nothing, and returned silently.
        expect(resolvePreselection({ view: 'clickhouseExplorer' }, profiles)).toBeUndefined();
        expect(resolvePreselection(undefined, profiles)).toBeUndefined();
    });

    it('ignores a name that no longer exists', () => {
        expect(resolvePreselection('deleted', profiles)).toBeUndefined();
    });
});


const setConfig = (vscode as unknown as { __setConfig(v: Record<string, unknown>): void }).__setConfig;
const setConfigAt = (vscode as unknown as { __setConfigAt(t: number, k: string, v: unknown): void }).__setConfigAt;
const resetConfig = (vscode as unknown as { __resetConfig(): void }).__resetConfig;

function makeContext() {
    const state: Record<string, unknown> = {};
    const secrets: Record<string, string> = {};
    return {
        context: {
            subscriptions: [],
            workspaceState: {
                get: (key: string, fallback?: unknown) => (key in state ? state[key] : fallback),
                update: async (key: string, value: unknown) => void (state[key] = value),
            },
            globalState: {
                get: (key: string, fallback?: unknown) => (key in state ? state[key] : fallback),
                update: async (key: string, value: unknown) => void (state[key] = value),
            },
            secrets: {
                get: async (key: string) => secrets[key],
                store: async (key: string, value: string) => void (secrets[key] = value),
                delete: async (key: string) => void delete secrets[key],
            },
        } as unknown as vscode.ExtensionContext,
        secrets,
    };
}

/**
 * Register the setup commands against a manager whose connection test is
 * stubbed, and hand back the command handlers by name.
 */
function setupCommands(testOutcome: { ok: boolean; description: string } = { ok: true, description: 'ok' }) {
    const { context, secrets } = makeContext();
    const manager = new ConnectionManager(context);
    manager.testProfile = jest.fn(async () => testOutcome) as typeof manager.testProfile;

    const handlers = new Map<string, (...args: unknown[]) => Promise<void>>();
    (vscode.commands.registerCommand as jest.Mock).mockImplementation(
        (name: string, handler: (...args: unknown[]) => Promise<void>) => {
            handlers.set(name, handler);
            return { dispose: jest.fn() };
        }
    );
    registerConnectionSetupCommands(manager);
    return { handlers, manager, secrets };
}

/**
 * Answer the five input boxes in order, then the quick picks in order.
 * `undefined` in a slot means the user pressed Escape there.
 */
function answer(inputs: (string | undefined)[], picks: unknown[]) {
    let inputIndex = 0;
    let pickIndex = 0;
    (vscode.window.showInputBox as jest.Mock).mockImplementation(async () => inputs[inputIndex++]);
    (vscode.window.showQuickPick as jest.Mock).mockImplementation(async () => picks[pickIndex++]);
}

/** The profiles as they now stand in settings. */
function savedProfiles(): ConnectionProfile[] {
    return (vscode.workspace.getConfiguration('clickhouse').get('connections', []) as ConnectionProfile[]) ?? [];
}

const PASSWORD_AUTH = { value: 'password' as const };
const READONLY = { value: 'readonly' as const };
const WRITE = { value: 'write' as const };
const PROTECTED = { value: 'protected' as const };
const USER_TARGET = { value: vscode.ConfigurationTarget.Global };

beforeEach(() => {
    jest.clearAllMocks();
    resetConfig();
    (vscode.workspace as unknown as { isTrusted: boolean }).isTrusted = true;
    (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = [{ uri: vscode.Uri.file('/w') }];
    setConfig({ connections: [] });
});

describe('adding a connection', () => {
    it('writes the profile, stores the password apart from it, and tests it', async () => {
        const { handlers, manager, secrets } = setupCommands();
        answer(
            ['ch.internal:8123', 'analytics', 'reader', 'hunter2', 'events'],
            [PASSWORD_AUTH, READONLY, USER_TARGET]
        );

        await handlers.get('clickhouse.addConnection')!();

        expect(savedProfiles()).toEqual([
            { name: 'analytics', host: 'ch.internal', port: 8123, protocol: 'http', user: 'reader', database: 'events' },
        ]);
        // The password is in the credential store, and nowhere in the settings value.
        expect(Object.values(secrets)).toContain('hunter2');
        expect(JSON.stringify(savedProfiles())).not.toContain('hunter2');
        expect(manager.testProfile).toHaveBeenCalledWith('analytics');
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('connected'));
    });

    it('leaves a new profile read-only', async () => {
        const { handlers } = setupCommands();
        answer(['localhost:8123', 'local', 'default', '', 'default'], [PASSWORD_AUTH, READONLY, USER_TARGET]);

        await handlers.get('clickhouse.addConnection')!();

        const profile = savedProfiles()[0];
        expect(profile.allowWrite).toBeUndefined();
        expect(profile.protected).toBeUndefined();
        // Defaults are left out rather than written back as noise.
        expect(profile.user).toBeUndefined();
        expect(profile.database).toBeUndefined();
    });

    it('records both flags for a protected profile', async () => {
        const { handlers } = setupCommands();
        answer(['prod.internal', 'prod', 'default', 'pw', 'default'], [PASSWORD_AUTH, PROTECTED, USER_TARGET]);

        await handlers.get('clickhouse.addConnection')!();

        expect(savedProfiles()[0]).toMatchObject({ allowWrite: true, protected: true });
    });

    it('records token auth without a user header', async () => {
        const { handlers } = setupCommands();
        answer(
            ['https://abc.clickhouse.cloud', 'abc', 'default', 'jwt-token', 'default'],
            [{ value: 'token' as const }, READONLY, USER_TARGET]
        );

        await handlers.get('clickhouse.addConnection')!();

        expect(savedProfiles()[0]).toMatchObject({ auth: 'token', protocol: 'https', port: 8443 });
    });

    it('appends rather than replacing what is already there', async () => {
        setConfigAt(vscode.ConfigurationTarget.Global, 'connections', [{ name: 'first', host: 'a' }]);
        const { handlers } = setupCommands();
        answer(['b', 'second', 'default', '', 'default'], [PASSWORD_AUTH, READONLY, USER_TARGET]);

        await handlers.get('clickhouse.addConnection')!();

        expect(savedProfiles().map(p => p.name)).toEqual(['first', 'second']);
    });

    it('writes nothing when the sequence is escaped', async () => {
        const { handlers } = setupCommands();
        answer(['ch.internal', undefined], []);

        await handlers.get('clickhouse.addConnection')!();

        expect(savedProfiles()).toEqual([]);
    });

    it('writes nothing when the settings file question is escaped', async () => {
        const { handlers, secrets } = setupCommands();
        answer(['ch.internal', 'x', 'default', 'pw', 'default'], [PASSWORD_AUTH, READONLY, undefined]);

        await handlers.get('clickhouse.addConnection')!();

        expect(savedProfiles()).toEqual([]);
        // Nor is a credential left behind for a profile that was never created.
        expect(Object.values(secrets)).not.toContain('pw');
    });

    it('offers a way forward when the saved profile cannot connect', async () => {
        const { handlers } = setupCommands({ ok: false, description: 'connection refused' });
        answer(['ch.internal', 'x', 'default', '', 'default'], [PASSWORD_AUTH, READONLY, USER_TARGET]);
        (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Edit Connections');

        await handlers.get('clickhouse.addConnection')!();

        // It is still saved - the work is not thrown away because the server is down.
        expect(savedProfiles().map(p => p.name)).toEqual(['x']);
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith('clickhouse.editConnection');
    });

    it('does not ask where to save outside a workspace', async () => {
        (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = undefined;
        const { handlers } = setupCommands();
        answer(['ch.internal', 'x', 'default', '', 'default'], [PASSWORD_AUTH, READONLY]);

        await handlers.get('clickhouse.addConnection')!();

        expect(savedProfiles().map(p => p.name)).toEqual(['x']);
    });
});

describe('editing a connection', () => {
    /** A profile already written to user settings. */
    function existing(overrides: Partial<ConnectionProfile> = {}) {
        const profile = { name: 'analytics', host: 'ch.internal', port: 8123, protocol: 'http', ...overrides };
        setConfigAt(vscode.ConfigurationTarget.Global, 'connections', [profile]);
        return profile;
    }

    it('offers to add one when there is nothing to edit', async () => {
        const { handlers } = setupCommands();
        await handlers.get('clickhouse.editConnection')!();
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith('clickhouse.addConnection');
    });

    it('edits the profile a menu names, without asking which', async () => {
        existing();
        const { handlers } = setupCommands();
        answer(['ch.internal:9000', 'analytics', 'default', '', 'default'], [PASSWORD_AUTH, READONLY]);

        await handlers.get('clickhouse.editConnection')!('analytics');

        expect(vscode.window.showQuickPick).not.toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ placeHolder: 'Edit which connection?' })
        );
        expect(savedProfiles()[0].port).toBe(9000);
    });

    it('asks which, when handed a menu context object rather than a name', async () => {
        // This is what a view/title menu passes, and it used to make the command
        // return without doing anything at all.
        existing();
        const { handlers } = setupCommands();
        let asked = false;
        (vscode.window.showQuickPick as jest.Mock).mockImplementation(async (_items, options) => {
            if (options?.placeHolder === 'Edit which connection?') {
                asked = true;
                return { label: 'analytics' };
            }
            return options?.title === 'What may this profile do?' ? READONLY : PASSWORD_AUTH;
        });
        (vscode.window.showInputBox as jest.Mock).mockImplementation(async (options) =>
            String(options?.prompt).startsWith('Server address') ? 'ch.internal:9001' : 'analytics'
        );

        await handlers.get('clickhouse.editConnection')!({ preserveFocus: true });

        expect(asked).toBe(true);
        expect(savedProfiles()[0].port).toBe(9001);
    });

    it('rewrites the profile in the settings file it already lives in', async () => {
        setConfigAt(vscode.ConfigurationTarget.Workspace, 'connections', [
            { name: 'shared', host: 'ch.internal', port: 8123 },
        ]);
        const { handlers } = setupCommands();
        answer(['ch.internal:9002', 'shared', 'default', '', 'default'], [PASSWORD_AUTH, READONLY]);

        await handlers.get('clickhouse.editConnection')!('shared');

        const inspected = vscode.workspace.getConfiguration('clickhouse').inspect<ConnectionProfile[]>('connections');
        expect(inspected?.workspaceValue?.[0].port).toBe(9002);
        // It did not have to ask where to put it, because it already knew.
        expect(vscode.window.showQuickPick).not.toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ placeHolder: 'Where should this profile be saved?' })
        );
    });

    it('moves the stored password with a rename, leaving nothing behind', async () => {
        existing();
        const { handlers, manager, secrets } = setupCommands();
        await manager.setPassword('analytics', 'old-secret');
        answer(['ch.internal:8123', 'renamed', 'default', '', 'default'], [PASSWORD_AUTH, READONLY]);

        await handlers.get('clickhouse.editConnection')!('analytics');

        expect(await manager.getPassword('renamed')).toBe('old-secret');
        expect(await manager.getPassword('analytics')).toBeUndefined();
        expect(Object.keys(secrets).filter(key => key.includes('analytics'))).toEqual([]);
    });

    it('keeps the stored password when the prompt is left empty', async () => {
        existing();
        const { handlers, manager } = setupCommands();
        await manager.setPassword('analytics', 'keep-me');
        answer(['ch.internal:8123', 'analytics', 'default', '', 'default'], [PASSWORD_AUTH, READONLY]);

        await handlers.get('clickhouse.editConnection')!('analytics');

        expect(await manager.getPassword('analytics')).toBe('keep-me');
    });

    it('can grant writes to a profile that was read-only', async () => {
        existing();
        const { handlers } = setupCommands();
        answer(['ch.internal:8123', 'analytics', 'default', '', 'default'], [PASSWORD_AUTH, WRITE]);

        await handlers.get('clickhouse.editConnection')!('analytics');

        expect(savedProfiles()[0]).toMatchObject({ allowWrite: true });
        expect(savedProfiles()[0].protected).toBeUndefined();
    });

    it('carries settings and the certificate exemption across an edit', async () => {
        existing({ settings: { max_threads: '4' }, allowInvalidCertificate: true });
        const { handlers } = setupCommands();
        answer(['ch.internal:8123', 'analytics', 'default', '', 'default'], [PASSWORD_AUTH, READONLY]);

        await handlers.get('clickhouse.editConnection')!('analytics');

        expect(savedProfiles()[0]).toMatchObject({
            settings: { max_threads: '4' },
            allowInvalidCertificate: true,
        });
    });

    it('says so when the named profile has since gone', async () => {
        existing();
        const { handlers } = setupCommands();
        (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({ label: 'vanished' });

        await handlers.get('clickhouse.editConnection')!();

        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('no connection'));
    });

    it('changes nothing when the sequence is escaped', async () => {
        existing();
        const { handlers } = setupCommands();
        answer([undefined], []);

        await handlers.get('clickhouse.editConnection')!('analytics');

        expect(savedProfiles()[0].port).toBe(8123);
    });
});

describe('removing a connection', () => {
    it('asks first, and does nothing when the confirmation is dismissed', async () => {
        setConfigAt(vscode.ConfigurationTarget.Global, 'connections', [{ name: 'analytics', host: 'h' }]);
        const { handlers } = setupCommands();
        (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({ label: 'analytics' });
        (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);

        await handlers.get('clickhouse.removeConnection')!();

        expect(savedProfiles().map(p => p.name)).toEqual(['analytics']);
    });

    it('removes the profile, its credential, and its place as the active one', async () => {
        setConfigAt(vscode.ConfigurationTarget.Global, 'connections', [
            { name: 'analytics', host: 'h' },
            { name: 'other', host: 'h' },
        ]);
        const { handlers, manager } = setupCommands();
        await manager.setPassword('analytics', 'secret');
        await manager.setActiveProfile('analytics');
        (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({ label: 'analytics' });
        (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Remove');

        await handlers.get('clickhouse.removeConnection')!();

        expect(savedProfiles().map(p => p.name)).toEqual(['other']);
        expect(await manager.getPassword('analytics')).toBeUndefined();
        // The removed profile cannot still be the active one; the remaining
        // profile takes over rather than leaving nothing selected.
        expect(manager.activeProfileName()).toBe('other');
    });

    it('says so when there is nothing to remove', async () => {
        const { handlers } = setupCommands();
        await handlers.get('clickhouse.removeConnection')!();
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('no connection'));
    });
});

describe('opening the settings file', () => {
    it('jumps straight to the connections setting', async () => {
        const { handlers } = setupCommands();
        await handlers.get('clickhouse.openConnectionSettings')!();
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            'workbench.action.openSettings',
            'clickhouse.connections'
        );
    });
});
