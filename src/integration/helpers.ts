/**
 * Shared helpers for the integration tests.
 */
import * as assert from 'node:assert';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

export const EXTENSION_ID = 'SuXarikisme.clickhouse-syntax';
export const SERVER_URL = process.env.CLICKHOUSE_TEST_URL ?? 'http://localhost:18123';

/** Wait for a condition, so tests do not depend on fixed sleeps. */
export async function eventually<T>(
    describe: string,
    probe: () => T | Promise<T>,
    predicate: (value: T) => boolean,
    timeoutMs = 30_000
): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let last: T | undefined;
    for (;;) {
        last = await probe();
        if (predicate(last)) return last;
        if (Date.now() > deadline) {
            throw new Error(`Timed out waiting for ${describe}. Last value: ${JSON.stringify(last)}`);
        }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
}

export async function activate(): Promise<vscode.Extension<unknown>> {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `${EXTENSION_ID} is not installed in the test instance`);
    if (!extension.isActive) await extension.activate();
    return extension;
}

/** Install a profile in the fixture workspace and make it active. */
export async function useProfile(profile: Record<string, unknown>): Promise<void> {
    const url = new URL(SERVER_URL);
    const config = vscode.workspace.getConfiguration('clickhouse');
    await config.update(
        'connections',
        [
            {
                host: url.hostname,
                port: Number(url.port || 8123),
                protocol: url.protocol === 'https:' ? 'https' : 'http',
                database: 'default',
                ...profile,
            },
        ],
        vscode.ConfigurationTarget.Workspace
    );
    // A single profile is selected automatically; going through the picker
    // would wait for a click that no test can make.
    await eventually(
        'the profile to become active',
        () => vscode.workspace.getConfiguration('clickhouse').get<Array<{ name: string }>>('connections', []),
        entries => entries.length === 1,
        10_000
    );
}

export async function clearProfiles(): Promise<void> {
    await vscode.workspace
        .getConfiguration('clickhouse')
        .update('connections', undefined, vscode.ConfigurationTarget.Workspace);
}

/** Open a ClickHouse document with the given text. */
export async function openDocument(content: string): Promise<vscode.TextEditor> {
    const document = await vscode.workspace.openTextDocument({ language: 'clickhouse', content });
    return vscode.window.showTextDocument(document);
}

/**
 * Write a runbook to a real file and open it as a notebook.
 *
 * A real file rather than an untitled one, because the point of several of
 * these tests is what does and does not end up on disk.
 */
export async function openNotebook(content: string): Promise<vscode.NotebookDocument> {
    const directory = os.tmpdir();
    const uri = vscode.Uri.file(path.join(directory, `it-${Date.now()}-${counter++}.runbook.sql`));
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
    return vscode.workspace.openNotebookDocument(uri);
}

let counter = 0;

/** Run a statement straight against the server, for setup and assertions. */
export async function serverQuery(sql: string): Promise<string> {
    const response = await fetch(`${SERVER_URL}/`, { method: 'POST', body: sql });
    const text = await response.text();
    if (!response.ok) throw new Error(`Server rejected setup query: ${text}`);
    return text.trim();
}
