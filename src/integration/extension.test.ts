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
import {
    activate,
    clearProfiles,
    eventually,
    EXTENSION_ID,
    openDocument,
    openNotebook,
    serverQuery,
    useProfile,
} from './helpers';

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
            'clickhouse.newNotebook',
            'clickhouse.openRunbookTemplate',
            'clickhouse.resetRunbookParameters',
            'clickhouse.explainStatementAt',
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

        it('offers Run and Explain above each statement', async function (this: Mocha.Context) {
            this.timeout(60_000);
            const editor = await openDocument('SELECT id FROM it_test.rows LIMIT 3;\n\nDROP TABLE it_test.nope;');
            const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
                'vscode.executeCodeLensProvider',
                editor.document.uri
            );
            const titles = (lenses ?? []).map(lens => lens.command?.title ?? '');
            assert.ok(
                titles.some(title => title.includes('Explain')),
                `no Explain lens among ${JSON.stringify(titles)}`
            );
            // The destructive statement is marked, and is not offered an EXPLAIN.
            assert.ok(titles.some(title => title.includes('$(warning) Run DROP')), JSON.stringify(titles));
            assert.strictEqual(titles.filter(title => title.includes('Explain')).length, 1);
        });

        it('runs a statement that ends in a semicolon', async function (this: Mocha.Context) {
            this.timeout(60_000);
            // The request ends with an appended FORMAT clause, so a trailing
            // terminator made ClickHouse read it as a second statement and
            // refuse the lot. Every notebook cell carries one.
            await openDocument('SELECT id FROM it_test.rows ORDER BY id LIMIT 7;');
            await vscode.commands.executeCommand('clickhouse.runQuery');
            const entry = await eventually(
                'the terminated query to finish',
                () => vscode.commands.executeCommand('clickhouse.debug.lastHistoryEntry'),
                (value: unknown) =>
                    typeof value === 'object' && value !== null && (value as { rows?: number }).rows === 7
            );
            assert.strictEqual((entry as { error?: string }).error, undefined);
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

    it('stays inside its performance budget', async function (this: Mocha.Context) {
        this.timeout(180_000);
        // Runs the real parser, binder and completion builder in the real
        // extension host. A budget nobody can check is a wish.
        const measurements = await vscode.commands.executeCommand<Map<string, { ms?: number }>>(
            'clickhouse.measurePerformance'
        );
        assert.ok(measurements, 'no measurements were returned');

        const budgets: Record<string, number> = {
            activation: 150,
            parse: 20,
            reparse: 5,
            completion: 50,
        };

        // The budget describes the product on a developer's machine. A shared
        // CI runner is slower and noisy, and a build that goes red on runner
        // variance teaches people to ignore the budget - so CI allows a wider
        // margin while still catching a real regression. The raw numbers are
        // logged either way.
        const allowance = process.env.CI ? 3 : 1;
        const over: string[] = [];
        for (const [id, limit] of Object.entries(budgets)) {
            const ms = measurements.get(id)?.ms;
            const allowed = limit * allowance;
            console.log(
                `      ${id.padEnd(12)} ${ms === undefined ? 'not measured' : `${ms.toFixed(2)} ms`}` +
                    ` (budget ${limit} ms${allowance > 1 ? `, allowed ${allowed} ms here` : ''})`
            );
            if (ms !== undefined && ms > allowed) over.push(`${id}: ${ms.toFixed(2)} ms > ${allowed} ms`);
        }
        assert.deepStrictEqual(over, [], `over budget — ${over.join('; ')}`);
    });

    describe('as a notebook', () => {
        before(async function (this: Mocha.Context) {
            this.timeout(60_000);
            await useProfile({ name: 'it-readonly', database: 'it_test' });
        });

        it('opens a .sql file as a notebook, split into cells', async function (this: Mocha.Context) {
            this.timeout(60_000);
            const notebook = await openNotebook(
                '-- %% markdown\n-- # Heading\n\n-- %%\nSELECT id FROM it_test.rows LIMIT 3\n'
            );
            assert.strictEqual(notebook.cellCount, 2);
            assert.strictEqual(notebook.cellAt(0).kind, vscode.NotebookCellKind.Markup);
            assert.strictEqual(notebook.cellAt(1).document.languageId, 'clickhouse');
        });

        it('offers one kernel per connection profile', async function (this: Mocha.Context) {
            this.timeout(60_000);
            const notebook = await openNotebook('-- %%\nSELECT 1\n');
            await vscode.window.showNotebookDocument(notebook);
            // The controller is registered under the profile's own name.
            const found = await eventually(
                'the kernel for the active profile',
                async () => vscode.commands.getCommands(true),
                () => true
            );
            assert.ok(Array.isArray(found));
        });

        it('runs a cell and puts the rows in the output, not in the file', async function (this: Mocha.Context) {
            this.timeout(120_000);
            // Terminated, as every saved cell is.
            const notebook = await openNotebook('-- %%\nSELECT id FROM it_test.rows ORDER BY id LIMIT 3;\n');
            const editor = await vscode.window.showNotebookDocument(notebook);
            await vscode.commands.executeCommand('notebook.selectKernel', {
                id: 'clickhouse-it-readonly',
                extension: EXTENSION_ID,
            });
            await vscode.commands.executeCommand('notebook.cell.execute', {
                ranges: [{ start: 0, end: 1 }],
                document: notebook.uri,
            });

            const entry = await eventually(
                'the cell to reach history',
                () => vscode.commands.executeCommand('clickhouse.debug.lastHistoryEntry'),
                (value: unknown) =>
                    typeof value === 'object' && value !== null && (value as { rows?: number }).rows === 3
            );
            assert.strictEqual((entry as { rows: number }).rows, 3);

            // The rows are in the output; the file itself still says only SQL.
            const outputs = editor.notebook.cellAt(0).outputs;
            assert.ok(outputs.length > 0, 'the cell produced no output');
            const saved = Buffer.from(
                await vscode.workspace.fs.readFile(notebook.uri)
            ).toString('utf8');
            assert.ok(!saved.includes('row-'), 'a query result was written to the file');
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
