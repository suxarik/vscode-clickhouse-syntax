/**
 * Commands for managing connection profiles.
 */
import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';
import { ClickHouseError } from './types';

function describe(error: unknown): string {
    if (error instanceof ClickHouseError) {
        return error.code !== undefined ? `${error.message} (code ${error.code})` : error.message;
    }
    return error instanceof Error ? error.message : String(error);
}

async function pickProfile(
    manager: ConnectionManager,
    placeHolder: string
): Promise<string | undefined> {
    const profiles = manager.profiles();
    if (profiles.length === 0) {
        vscode.window.showWarningMessage(
            'ClickHouse: no connection profiles. Add one to "clickhouse.connections".'
        );
        return undefined;
    }
    if (profiles.length === 1) return profiles[0].name;

    const active = manager.activeProfileName();
    const picked = await vscode.window.showQuickPick(
        profiles.map(profile => ({
            label: profile.name,
            description: `${profile.protocol ?? 'http'}://${profile.host}:${profile.port ?? 8123}`,
            detail: [
                profile.allowWrite === true ? 'writes permitted' : 'read-only',
                profile.protected === true ? 'protected' : '',
                profile.name === active ? 'active' : '',
            ]
                .filter(Boolean)
                .join(' · '),
        })),
        { placeHolder }
    );
    return picked?.label;
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
            const name = await pickProfile(manager, 'Which ClickHouse server should queries run against?');
            if (name) await manager.setActiveProfile(name);
        }),

        vscode.commands.registerCommand('clickhouse.testConnection', async () => {
            const name = await pickProfile(manager, 'Test which connection?');
            if (!name) return;

            const client = await manager.client(name);
            if (!client) return;

            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `ClickHouse: testing '${name}'…` },
                async () => {
                    try {
                        const result = await client.query(
                            'SELECT version(), currentUser(), currentDatabase(), uptime()',
                            { readOnly: true, maxExecutionTime: 15 }
                        );
                        const [version, user, database, uptime] = result.rows[0] ?? [];
                        vscode.window.showInformationMessage(
                            `ClickHouse '${name}': v${version} as ${user}, database ${database}, up ${uptime}s.`
                        );
                    } catch (error) {
                        vscode.window.showErrorMessage(`ClickHouse '${name}': ${describe(error)}`);
                    }
                }
            );
        }),

        vscode.commands.registerCommand('clickhouse.setConnectionPassword', async () => {
            const name = await pickProfile(manager, 'Set the password for which connection?');
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
            const name = await pickProfile(manager, 'Clear the password for which connection?');
            if (!name) return;
            await manager.clearPassword(name);
            vscode.window.showInformationMessage(`ClickHouse: password for '${name}' cleared.`);
        }),
    ];
}
