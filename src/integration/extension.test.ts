/**
 * End-to-end tests: the real extension, in a real VS Code, against a real
 * ClickHouse.
 *
 * Every failure found while testing 2.0 by hand had already passed the unit
 * suite — a request that hung in the extension host, an explorer showing a
 * cached schema as though it were live, a command that returned silently.
 * Mocked transports and a stubbed `vscode` cannot see any of that.
 */
import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { activate, clearProfiles, eventually, openDocument, serverQuery, useProfile } from './helpers';

describe('ClickHouse extension', () => {
    before(async function (this: Mocha.Context) {
        this.timeout(120_000);
        await activate();
        await serverQuery('CREATE DATABASE IF NOT EXISTS it_test');
        await serverQuery(
            'CREATE TABLE IF NOT EXISTS it_test.rows (id UInt64, name String) ENGINE = MergeTree ORDER BY id'
        );
        await serverQuery('TRUNCATE TABLE it_test.rows');
        await serverQuery(
            "INSERT INTO it_test.rows SELECT number, concat('row-', toString(number)) FROM numbers(5000)"
        );
    });

    after(async () => {
        await clearProfiles();
    });

    it('activates', async () => {
        const extension = await activate();
        assert.strictEqual(extension.isActive, true);
    });

    it('registers its commands', async () => {
        const commands = await vscode.commands.getCommands(true);
        for (const command of [
            'clickhouse.runQuery',
            'clickhouse.addConnection',
            'clickhouse.editConnection',
            'clickhouse.previewTable',
            'clickhouse.explainQuery',
            'clickhouse.diagnoseConnection',
        ]) {
            assert.ok(commands.includes(command), `${command} is not registered`);
        }
    });

    describe('with a read-only connection', () => {
        before(async function (this: Mocha.Context) {
            this.timeout(60_000);
            await useProfile({ name: 'it-readonly', database: 'it_test' });
        });

        it('connects to the server', async () => {
            // The hang that cost an afternoon would fail right here.
            await vscode.commands.executeCommand('clickhouse.testConnection');
        });

        it('introspects the schema into the explorer', async function (this: Mocha.Context) {
            this.timeout(60_000);
            await vscode.commands.executeCommand('clickhouse.refreshExplorer');
            const found = await eventually(
                'it_test.rows to appear in completions',
                async () => {
                    const editor = await openDocument('SELECT  FROM it_test.rows');
                    const position = new vscode.Position(0, 7);
                    const list = await vscode.commands.executeCommand<vscode.CompletionList>(
                        'vscode.executeCompletionItemProvider',
                        editor.document.uri,
                        position
                    );
                    return (list?.items ?? []).map(item =>
                        typeof item.label === 'string' ? item.label : item.label.label
                    );
                },
                labels => labels.includes('id') && labels.includes('name')
            );
            assert.ok(found.includes('id'));
        });

        it('runs a query and returns rows', async function (this: Mocha.Context) {
            this.timeout(60_000);
            // Nothing below matters if this does not work.
            await openDocument('SELECT id, name FROM it_test.rows ORDER BY id LIMIT 10');
            await vscode.commands.executeCommand('clickhouse.runQuery');
            // The panel is a webview, so the observable outcome is the history.
            const entry = await eventually(
                'the query to reach history',
                () => vscode.commands.executeCommand('clickhouse.debug.lastHistoryEntry'),
                (value: unknown) => typeof value === 'object' && value !== null && 'rows' in value
            );
            assert.strictEqual((entry as { rows: number }).rows, 10);
            assert.strictEqual((entry as { error?: string }).error, undefined);
        });

        it('streams a result too large for one buffer', async function (this: Mocha.Context) {
            this.timeout(120_000);
            // Small replies succeeded while streaming was broken, so this is
            // deliberately many chunks.
            await openDocument('SELECT id, name FROM it_test.rows');
            await vscode.commands.executeCommand('clickhouse.runQuery');
            const entry = await eventually(
                'the large query to finish',
                () => vscode.commands.executeCommand('clickhouse.debug.lastHistoryEntry'),
                (value: unknown) =>
                    typeof value === 'object' && value !== null && (value as { rows?: number }).rows === 5000
            );
            assert.strictEqual((entry as { rows: number }).rows, 5000);
        });

        it('refuses a write, and the server confirms nothing happened', async function (this: Mocha.Context) {
            this.timeout(60_000);
            await openDocument('CREATE TABLE it_test.must_not_exist (a UInt8) ENGINE = Memory');
            await vscode.commands.executeCommand('clickhouse.runQuery');

            // Give the command time to have done the wrong thing.
            await new Promise(resolve => setTimeout(resolve, 2000));
            const count = await serverQuery(
                "SELECT count() FROM system.tables WHERE database = 'it_test' AND name = 'must_not_exist'"
            );
            assert.strictEqual(count, '0', 'a read-only profile created a table');
        });
    });

    describe('with a writable connection', () => {
        before(async function (this: Mocha.Context) {
            this.timeout(60_000);
            await useProfile({ name: 'it-write', database: 'it_test', allowWrite: true });
        });

        it('reports a server error rather than failing silently', async function (this: Mocha.Context) {
            this.timeout(60_000);
            await openDocument('SELECT * FROM it_test.no_such_table');
            await vscode.commands.executeCommand('clickhouse.runQuery');
            const entry = await eventually(
                'the failure to reach history',
                () => vscode.commands.executeCommand('clickhouse.debug.lastHistoryEntry'),
                (value: unknown) =>
                    typeof value === 'object' && value !== null && Boolean((value as { error?: string }).error)
            );
            assert.match((entry as { error: string }).error, /no_such_table/);
        });
    });
});
