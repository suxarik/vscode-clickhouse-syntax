/**
 * Commands for managing connection profiles.
 */
import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';

const ADD_NEW = '$(add) Add a connection…';

/**
 * Choose a profile, always offering the way to create one.
 *
 * Being told there are no profiles is not useful; being offered to make one is.
 */
async function pickProfile(
    manager: ConnectionManager,
    placeHolder: string,
    options: { offerAdd?: boolean; alwaysAsk?: boolean } = {}
): Promise<string | undefined> {
    const profiles = manager.profiles();
    const offerAdd = options.offerAdd !== false;

    // With a single profile there is nothing to choose, so only the command
    // whose whole purpose is choosing should interrupt.
    if (profiles.length === 1 && !options.alwaysAsk) return profiles[0].name;

    if (profiles.length === 0) {
        if (!offerAdd) {
            vscode.window.showWarningMessage('ClickHouse: there are no connection profiles yet.');
            return undefined;
        }
        await vscode.commands.executeCommand('clickhouse.addConnection');
        return undefined;
    }

    const active = manager.activeProfileName();
    const items: vscode.QuickPickItem[] = profiles.map(profile => ({
        label: profile.name,
        description: `${profile.protocol ?? 'http'}://${profile.host}:${profile.port ?? 8123}`,
        detail: [
            profile.allowWrite === true ? 'writes permitted' : 'read-only',
            profile.protected === true ? 'protected' : '',
            profile.name === active ? 'active' : '',
        ]
            .filter(Boolean)
            .join(' · '),
    }));
    if (offerAdd) {
        items.push({ label: '', kind: vscode.QuickPickItemKind.Separator }, { label: ADD_NEW });
    }

    const picked = await vscode.window.showQuickPick(items, { placeHolder });
    if (!picked) return undefined;
    if (picked.label === ADD_NEW) {
        await vscode.commands.executeCommand('clickhouse.addConnection');
        return undefined;
    }
    return picked.label;
}

export function registerConnectionCommands(manager: ConnectionManager): vscode.Disposable[] {
    return [
        vscode.commands.registerCommand('clickhouse.selectConnection', async () => {
            const issues = manager.issues();
            if (issues.length > 0) {
                vscode.window.showWarningMessage(
                    `ClickHouse: ${issues.length} connection profile issue(s): ${issues[0].message}`
                );
            }
            const name = await pickProfile(manager, 'Which ClickHouse server should queries run against?', {
                alwaysAsk: true,
            });
            if (name) await manager.setActiveProfile(name);
        }),

        vscode.commands.registerCommand('clickhouse.testConnection', async () => {
            const name = await pickProfile(manager, 'Test which connection?');
            if (!name) return;

            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `ClickHouse: testing '${name}'…` },
                async () => {
                    const outcome = await manager.testProfile(name);
                    if (outcome.ok) {
                        vscode.window.showInformationMessage(`ClickHouse '${name}': ${outcome.description}`);
                    } else {
                        vscode.window.showErrorMessage(`ClickHouse '${name}': ${outcome.description}`);
                    }
                }
            );
        }),

        vscode.commands.registerCommand('clickhouse.setConnectionPassword', async () => {
            const name = await pickProfile(manager, 'Set the password for which connection?', { offerAdd: false });
            if (!name) return;
            const password = await vscode.window.showInputBox({
                prompt: `Password for ClickHouse profile '${name}'`,
                password: true,
                ignoreFocusOut: true,
            });
            if (password === undefined) return;
            await manager.setPassword(name, password);
            vscode.window.showInformationMessage(
                `ClickHouse: password for '${name}' saved to the OS credential store.`
            );
        }),

        vscode.commands.registerCommand('clickhouse.clearConnectionPassword', async () => {
            const name = await pickProfile(manager, 'Clear the password for which connection?', { offerAdd: false });
            if (!name) return;
            await manager.clearPassword(name);
            vscode.window.showInformationMessage(`ClickHouse: password for '${name}' cleared.`);
        }),
    ];
}
