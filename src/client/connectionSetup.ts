/**
 * Creating and managing connection profiles from the UI.
 *
 * Hand-editing `settings.json` is a fine way to manage profiles once you know
 * the shape, and a terrible way to meet the extension for the first time. This
 * is the guided path: paste a URL, answer a few questions, and the profile is
 * written for you - with the password going to the credential store rather than
 * to any file.
 */
import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';
import { ConnectionProfile } from './types';

interface ParsedTarget {
    protocol: 'http' | 'https';
    host: string;
    port: number;
}

/**
 * Accepts what people actually have to hand: a bare host, `host:port`, or a
 * full URL pasted out of a console.
 */
export function parseTarget(input: string): ParsedTarget | undefined {
    const text = input.trim();
    if (!text) return undefined;

    const withScheme = /^https?:\/\//i.test(text) ? text : `http://${text}`;
    let url: URL;
    try {
        url = new URL(withScheme);
    } catch {
        return undefined;
    }
    if (!url.hostname) return undefined;

    // ClickHouse Cloud hands out https URLs without a port.
    const protocol = url.protocol === 'https:' ? 'https' : 'http';
    const explicitPort = url.port ? Number(url.port) : undefined;
    return {
        protocol,
        host: url.hostname,
        port: explicitPort ?? (protocol === 'https' ? 8443 : 8123),
    };
}

/** A name derived from a host, for the default profile name. */
export function suggestName(host: string, taken: string[]): string {
    const base = host === 'localhost' || host === '127.0.0.1' ? 'local' : host.split('.')[0] || 'clickhouse';
    if (!taken.includes(base)) return base;
    for (let i = 2; i < 100; i++) {
        if (!taken.includes(`${base}-${i}`)) return `${base}-${i}`;
    }
    return base;
}

type AccessChoice = 'readonly' | 'write' | 'protected';

const ACCESS_ITEMS: Array<vscode.QuickPickItem & { value: AccessChoice }> = [
    {
        label: '$(shield) Read-only',
        description: 'recommended',
        detail: 'Refuses INSERT, DDL and anything destructive. You can change this later.',
        value: 'readonly',
    },
    {
        label: '$(pencil) Allow writes',
        detail: 'Writes are permitted, and each one asks for confirmation first.',
        value: 'write',
    },
    {
        label: '$(lock) Allow writes, protected',
        detail: 'Writes are permitted but require the profile name to be typed. For production.',
        value: 'protected',
    },
];

/** Where the profile is written. Workspace settings can end up committed. */
async function pickTarget(): Promise<vscode.ConfigurationTarget | undefined> {
    if (!vscode.workspace.workspaceFolders?.length) return vscode.ConfigurationTarget.Global;

    const picked = await vscode.window.showQuickPick(
        [
            {
                label: '$(account) User settings',
                description: 'available in every workspace',
                detail: 'Kept out of the repository.',
                value: vscode.ConfigurationTarget.Global,
            },
            {
                label: '$(folder) Workspace settings',
                description: 'this project only',
                detail: 'Written to .vscode/settings.json, which is usually committed.',
                value: vscode.ConfigurationTarget.Workspace,
            },
        ],
        { placeHolder: 'Where should this profile be saved?' }
    );
    return picked?.value;
}

/** Profiles already written at a given target, so we append rather than replace. */
function existingAt(target: vscode.ConfigurationTarget): ConnectionProfile[] {
    const inspected = vscode.workspace.getConfiguration('clickhouse').inspect<ConnectionProfile[]>('connections');
    const value =
        target === vscode.ConfigurationTarget.Global ? inspected?.globalValue : inspected?.workspaceValue;
    return Array.isArray(value) ? value : [];
}

/** Access level implied by an existing profile. */
function accessOf(profile: ConnectionProfile | undefined): AccessChoice {
    if (!profile?.allowWrite) return 'readonly';
    return profile.protected ? 'protected' : 'write';
}

interface PromptResult {
    profile: ConnectionProfile;
    /** undefined means "leave the stored password alone". */
    password?: string;
}

/**
 * The shared question sequence, used for both adding and editing.
 * Editing pre-fills every answer from the existing profile.
 */
async function promptForProfile(
    manager: ConnectionManager,
    existing?: ConnectionProfile
): Promise<PromptResult | undefined> {
    const verb = existing ? 'Edit' : 'Add';
    const taken = manager
        .profiles()
        .map(profile => profile.name)
        .filter(name => name !== existing?.name);

    const currentAddress = existing
        ? `${existing.protocol ?? 'http'}://${existing.host}:${existing.port ?? 8123}`
        : 'localhost:8123';

    const targetInput = await vscode.window.showInputBox({
        title: `${verb} ClickHouse connection (1/5)`,
        prompt: 'Server address',
        placeHolder: 'localhost:8123, or https://abc.clickhouse.cloud:8443',
        value: currentAddress,
        ignoreFocusOut: true,
        validateInput: value => (parseTarget(value) ? undefined : 'Enter a host, host:port, or a full URL.'),
    });
    if (!targetInput) return undefined;
    const parsed = parseTarget(targetInput)!;

    const name = await vscode.window.showInputBox({
        title: `${verb} ClickHouse connection (2/5)`,
        prompt: 'Name for this profile',
        value: existing?.name ?? suggestName(parsed.host, taken),
        ignoreFocusOut: true,
        validateInput: value => {
            const trimmed = value.trim();
            if (!trimmed) return 'A name is required.';
            if (taken.includes(trimmed)) return `There is already a profile called "${trimmed}".`;
            return undefined;
        },
    });
    if (!name) return undefined;

    const user = await vscode.window.showInputBox({
        title: `${verb} ClickHouse connection (3/5)`,
        prompt: 'Username',
        value: existing?.user ?? 'default',
        ignoreFocusOut: true,
    });
    if (user === undefined) return undefined;

    const password = await vscode.window.showInputBox({
        title: `${verb} ClickHouse connection (4/5)`,
        prompt: existing
            ? 'Password (leave empty to keep the stored one)'
            : 'Password (leave empty if there is none)',
        password: true,
        ignoreFocusOut: true,
    });
    if (password === undefined) return undefined;

    const database = await vscode.window.showInputBox({
        title: `${verb} ClickHouse connection (5/5)`,
        prompt: 'Default database',
        value: existing?.database ?? 'default',
        ignoreFocusOut: true,
    });
    if (database === undefined) return undefined;

    const currentAccess = accessOf(existing);
    const access = await vscode.window.showQuickPick(
        ACCESS_ITEMS.map(item =>
            item.value === currentAccess ? { ...item, description: [item.description, 'current'].filter(Boolean).join(' · ') } : item
        ),
        { title: 'What may this profile do?', placeHolder: 'Access level', ignoreFocusOut: true }
    );
    if (!access) return undefined;

    const profile: ConnectionProfile = {
        name: name.trim(),
        host: parsed.host,
        port: parsed.port,
        protocol: parsed.protocol,
    };
    if (user.trim() && user.trim() !== 'default') profile.user = user.trim();
    if (database.trim() && database.trim() !== 'default') profile.database = database.trim();
    if (access.value !== 'readonly') profile.allowWrite = true;
    if (access.value === 'protected') profile.protected = true;
    if (existing?.settings) profile.settings = existing.settings;

    return password ? { profile, password } : { profile };
}

export function registerConnectionSetupCommands(manager: ConnectionManager): vscode.Disposable[] {
    return [
        vscode.commands.registerCommand('clickhouse.addConnection', async () => {
            const answered = await promptForProfile(manager);
            if (!answered) return;
            const { profile, password } = answered;

            const target = await pickTarget();
            if (target === undefined) return;

            // The password is stored before the profile, so the test below can use it.
            if (password) await manager.setPassword(profile.name, password);

            await vscode.workspace
                .getConfiguration('clickhouse')
                .update('connections', [...existingAt(target), profile], target);

            await manager.setActiveProfile(profile.name);

            // Tell them now if it does not work, rather than at the first query.
            const outcome = await manager.testProfile(profile.name);
            if (outcome.ok) {
                vscode.window.showInformationMessage(
                    `ClickHouse: connected to '${profile.name}' - ${outcome.description}`
                );
            } else {
                const choice = await vscode.window.showWarningMessage(
                    `ClickHouse: saved '${profile.name}', but could not connect - ${outcome.description}`,
                    'Edit Connections'
                );
                if (choice === 'Edit Connections') {
                    await vscode.commands.executeCommand('clickhouse.editConnection');
                }
            }
        }),

        vscode.commands.registerCommand('clickhouse.editConnection', async (preselected?: string) => {
            const profiles = manager.profiles();
            if (profiles.length === 0) {
                await vscode.commands.executeCommand('clickhouse.addConnection');
                return;
            }

            let name = preselected;
            if (!name) {
                const picked = await vscode.window.showQuickPick(
                    profiles.map(profile => ({
                        label: profile.name,
                        description: `${profile.protocol ?? 'http'}://${profile.host}:${profile.port ?? 8123}`,
                        detail: profile.allowWrite === true ? 'writes permitted' : 'read-only',
                    })),
                    { placeHolder: 'Edit which connection?' }
                );
                name = picked?.label;
            }
            if (!name) return;

            const existing = profiles.find(profile => profile.name === name);
            if (!existing) return;

            const answered = await promptForProfile(manager, existing);
            if (!answered) return;
            const { profile, password } = answered;

            // Rewrite it wherever it currently lives.
            let written = false;
            for (const target of [vscode.ConfigurationTarget.Global, vscode.ConfigurationTarget.Workspace]) {
                const current = existingAt(target);
                if (!current.some(entry => entry.name === existing.name)) continue;
                await vscode.workspace
                    .getConfiguration('clickhouse')
                    .update(
                        'connections',
                        current.map(entry => (entry.name === existing.name ? profile : entry)),
                        target
                    );
                written = true;
            }
            if (!written) {
                const target = await pickTarget();
                if (target === undefined) return;
                await vscode.workspace
                    .getConfiguration('clickhouse')
                    .update('connections', [...existingAt(target), profile], target);
            }

            if (password) await manager.setPassword(profile.name, password);
            // A rename leaves the old credential behind otherwise.
            if (profile.name !== existing.name) {
                const stored = await manager.getPassword(existing.name);
                if (stored && !password) await manager.setPassword(profile.name, stored);
                await manager.clearPassword(existing.name);
            }
            await manager.setActiveProfile(profile.name);

            const outcome = await manager.testProfile(profile.name);
            vscode.window[outcome.ok ? 'showInformationMessage' : 'showWarningMessage'](
                `ClickHouse '${profile.name}': ${outcome.description}`
            );
        }),

        vscode.commands.registerCommand('clickhouse.openConnectionSettings', async () => {
            await vscode.commands.executeCommand('workbench.action.openSettings', 'clickhouse.connections');
        }),

        vscode.commands.registerCommand('clickhouse.removeConnection', async () => {
            const profiles = manager.profiles();
            if (profiles.length === 0) {
                vscode.window.showInformationMessage('ClickHouse: there are no connection profiles to remove.');
                return;
            }

            const picked = await vscode.window.showQuickPick(
                profiles.map(profile => ({
                    label: profile.name,
                    description: `${profile.protocol ?? 'http'}://${profile.host}:${profile.port ?? 8123}`,
                })),
                { placeHolder: 'Remove which connection?' }
            );
            if (!picked) return;

            const confirmed = await vscode.window.showWarningMessage(
                `Remove the connection profile '${picked.label}'?`,
                { modal: true },
                'Remove'
            );
            if (confirmed !== 'Remove') return;

            // The profile may live in either target; clear it from both.
            for (const target of [vscode.ConfigurationTarget.Global, vscode.ConfigurationTarget.Workspace]) {
                const remaining = existingAt(target).filter(profile => profile.name !== picked.label);
                if (remaining.length !== existingAt(target).length) {
                    await vscode.workspace.getConfiguration('clickhouse').update('connections', remaining, target);
                }
            }
            await manager.clearPassword(picked.label);
            if (manager.activeProfileName() === picked.label) await manager.setActiveProfile(undefined);

            vscode.window.showInformationMessage(`ClickHouse: removed '${picked.label}'.`);
        }),
    ];
}
