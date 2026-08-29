/**
 * Tests for the notebook: the serializer, the controllers, and the promise that
 * no query result is ever written to the file.
 */
import * as vscode from 'vscode';
import { ClickHouseNotebookSerializer, NOTEBOOK_TYPE } from '../notebook/serializer';
import { NotebookControllers, RESULT_MIME, summaryText, CellResult } from '../notebook/controller';
import { registerNotebook } from '../notebook';
import { ConnectionManager } from '../client/connectionManager';
import { QueryRunner } from '../client/queryRunner';
import { AnalysisCache } from '../analysis';
import { Catalog } from '../catalog';
import { ResultSink } from '../results/sink';
import { makeSchemaManager, makeCatalog } from './helpers';

const setConfig = (vscode as unknown as { __setConfig(v: Record<string, unknown>): void }).__setConfig;
const controllersById = (vscode as unknown as { __notebookControllers: Record<string, MockController> })
    .__notebookControllers;

interface MockController {
    id: string;
    label: string;
    description?: string;
    supportedLanguages: string[];
    executeHandler?: (
        cells: unknown[],
        notebook: unknown,
        controller: MockController
    ) => Promise<void>;
    interruptHandler?: () => Promise<void>;
    createNotebookCellExecution: jest.Mock;
    dispose: jest.Mock;
}

let analysisCache: AnalysisCache;
let catalog: Catalog;

beforeAll(async () => {
    catalog = makeCatalog();
    await catalog.systemTables();
    analysisCache = new AnalysisCache(await makeSchemaManager(), catalog);
});

function makeContext() {
    const state: Record<string, unknown> = {};
    return {
        subscriptions: [],
        workspaceState: {
            get: (key: string, fallback?: unknown) => (key in state ? state[key] : fallback),
            update: async (key: string, value: unknown) => void (state[key] = value),
        },
        globalState: {
            get: (key: string, fallback?: unknown) => (key in state ? state[key] : fallback),
            update: async (key: string, value: unknown) => void (state[key] = value),
        },
        secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined },
    } as unknown as vscode.ExtensionContext;
}

beforeEach(() => {
    jest.clearAllMocks();
    (vscode as unknown as { __resetConfig(): void }).__resetConfig();
    (vscode.workspace as unknown as { isTrusted: boolean }).isTrusted = true;
    for (const key of Object.keys(controllersById)) delete controllersById[key];
});

describe('the serializer', () => {
    const serializer = new ClickHouseNotebookSerializer();
    const encode = (text: string) => new TextEncoder().encode(text);
    const decode = (data: Uint8Array) => new TextDecoder().decode(data);

    it('turns a marked-up script into cells of the right kind', () => {
        const data = serializer.deserializeNotebook(
            encode('-- %% markdown\n-- # Heading\n\n-- %%\nSELECT 1\n')
        );
        expect(data.cells.map(cell => cell.kind)).toEqual([
            vscode.NotebookCellKind.Markup,
            vscode.NotebookCellKind.Code,
        ]);
        expect(data.cells.map(cell => cell.languageId)).toEqual(['markdown', 'clickhouse']);
        expect(data.cells[0].value).toBe('# Heading');
    });

    it('leaves a file it did not change exactly as it was', () => {
        const file = '-- %% markdown\n-- # Why is this slow\n\n-- %%\nSELECT count() FROM system.parts\n';
        expect(decode(serializer.serializeNotebook(serializer.deserializeNotebook(encode(file))))).toBe(file);
    });

    it('opens a plain script as a notebook without rewriting its first line', () => {
        const file = 'SELECT 1\n';
        expect(decode(serializer.serializeNotebook(serializer.deserializeNotebook(encode(file))))).toBe(file);
    });

    it('separates cells that were added in the editor', () => {
        const data = new vscode.NotebookData([
            new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'SELECT 1', 'clickhouse'),
            new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'SELECT 2', 'clickhouse'),
        ]);
        const text = decode(serializer.serializeNotebook(data));
        // The first cell gains a terminator, or clickhouse-client would read
        // both cells as one malformed statement.
        expect(text).toBe('SELECT 1;\n\n-- %%\nSELECT 2');
        // And reading it back gives the two cells again, not one.
        expect(serializer.deserializeNotebook(encode(text)).cells).toHaveLength(2);
    });

    it('re-marks a cell whose kind changed in the editor', () => {
        const data = serializer.deserializeNotebook(encode('-- %% markdown\n-- prose\n'));
        // The user turned the markdown cell into a SQL cell.
        data.cells[0].kind = vscode.NotebookCellKind.Code;
        data.cells[0].value = 'SELECT 1';
        const text = decode(serializer.serializeNotebook(data));
        expect(text).toContain('-- %%');
        expect(text).not.toContain('markdown');
        expect(serializer.deserializeNotebook(encode(text)).cells[0].kind).toBe(vscode.NotebookCellKind.Code);
    });

    it('writes no output, even when the cell has one', () => {
        // This is the whole point of the format: a file that persists query
        // results is a way for production rows to end up in a commit.
        const data = serializer.deserializeNotebook(encode('-- %%\nSELECT secret FROM users\n'));
        data.cells[0].outputs = [
            new vscode.NotebookCellOutput([
                vscode.NotebookCellOutputItem.json({ rows: [['hunter2']] }, RESULT_MIME),
            ]),
        ];
        const text = decode(serializer.serializeNotebook(data));
        expect(text).toBe('-- %%\nSELECT secret FROM users\n');
        expect(text).not.toContain('hunter2');
    });

    it('stays a script that clickhouse-client would accept', () => {
        const file = decode(
            serializer.serializeNotebook(
                serializer.deserializeNotebook(encode('-- %% md\n-- prose\n\n-- %%\nSELECT 1;\n'))
            )
        );
        for (const line of file.split('\n')) {
            const ok = line.trim() === '' || line.trimStart().startsWith('--') || line.startsWith('SELECT');
            expect({ line, ok }).toMatchObject({ ok: true });
        }
    });
});

describe('controllers', () => {
    function makeControllers(profiles: unknown[]) {
        setConfig({ connections: profiles });
        const connections = new ConnectionManager(makeContext());
        const runner = {
            run: jest.fn(async (_target: unknown, _sink?: ResultSink) => undefined),
            cancel: jest.fn(async () => undefined),
        };
        const controllers = new NotebookControllers(
            connections,
            runner as unknown as QueryRunner,
            analysisCache
        );
        return { controllers, runner, connections };
    }

    it('creates one per profile, so the kernel picker is the profile picker', () => {
        const { controllers } = makeControllers([
            { name: 'local', host: 'localhost' },
            { name: 'prod', host: 'ch.internal' },
        ]);
        expect(Object.values(controllersById).map(controller => controller.label).sort()).toEqual([
            'local',
            'prod',
        ]);
        expect(Object.values(controllersById)[0].supportedLanguages).toContain('clickhouse');
        controllers.dispose();
    });

    it('says what the profile is allowed to do, not just where it is', () => {
        const { controllers } = makeControllers([
            { name: 'ro', host: 'a' },
            { name: 'rw', host: 'b', allowWrite: true },
            { name: 'prod', host: 'c', allowWrite: true, protected: true },
        ]);
        const described = Object.fromEntries(
            Object.values(controllersById).map(controller => [controller.label, controller.description])
        );
        expect(described.ro).toContain('read-only');
        expect(described.rw).toContain('writes permitted');
        expect(described.prod).toContain('protected');
        controllers.dispose();
    });

    it('drops a controller for a profile that has gone', () => {
        const { controllers } = makeControllers([{ name: 'a', host: 'h' }, { name: 'b', host: 'h' }]);
        setConfig({ connections: [{ name: 'a', host: 'h' }] });
        (controllers as unknown as { sync(): void }).sync();
        expect(Object.values(controllersById).map(controller => controller.label)).toEqual(['a']);
        controllers.dispose();
    });

    it('disposes everything it made', () => {
        const { controllers } = makeControllers([{ name: 'a', host: 'h' }]);
        const made = Object.values(controllersById)[0];
        controllers.dispose();
        expect(made.dispose).toHaveBeenCalled();
    });

    /** An execution that records what the controller does to it. */
    function makeExecution() {
        const execution = {
            executionOrder: 0,
            token: { onCancellationRequested: jest.fn() },
            start: jest.fn(),
            end: jest.fn(),
            replaceOutput: jest.fn(async (_output: unknown) => undefined),
        };
        return execution;
    }

    function makeCell(text: string, outputs: unknown[] = []) {
        return { document: { getText: () => text }, outputs };
    }

    /** The notebook a cell belongs to, identified by its URI. */
    const notebook = { uri: vscode.Uri.file('/w/incident.runbook.sql') } as unknown as vscode.NotebookDocument;

    it('runs a cell through the same runner as the editor, so the gate still applies', async () => {
        const { controllers, runner, connections } = makeControllers([{ name: 'local', host: 'h' }]);
        const controller = Object.values(controllersById)[0];
        const execution = makeExecution();
        controller.createNotebookCellExecution.mockReturnValue(execution);

        await controller.executeHandler!([makeCell('SELECT 1')], notebook, controller);

        expect(runner.run).toHaveBeenCalledWith(
            expect.objectContaining({ sql: 'SELECT 1' }),
            expect.anything()
        );
        // Running a cell says which server to use.
        expect(connections.activeProfileName()).toBe('local');
        expect(execution.start).toHaveBeenCalled();
        expect(execution.end).toHaveBeenCalled();
        controllers.dispose();
    });

    it('does not send an empty cell to the server', async () => {
        const { controllers, runner } = makeControllers([{ name: 'local', host: 'h' }]);
        const controller = Object.values(controllersById)[0];
        controller.createNotebookCellExecution.mockReturnValue(makeExecution());

        await controller.executeHandler!([makeCell('   \n')], notebook, controller);

        expect(runner.run).not.toHaveBeenCalled();
        controllers.dispose();
    });

    it('stops at the first failure, because a runbook is a sequence', async () => {
        const { controllers, runner } = makeControllers([{ name: 'local', host: 'h' }]);
        const controller = Object.values(controllersById)[0];
        controller.createNotebookCellExecution.mockImplementation(() => makeExecution());

        const failed = makeCell('SELECT bad', [
            { items: [{ mime: 'application/vnd.code.notebook.error' }] },
        ]);
        await controller.executeHandler!([failed, makeCell('SELECT 2')], notebook, controller);

        expect(runner.run).toHaveBeenCalledTimes(1);
        controllers.dispose();
    });

    it('asks for a parameter once, then remembers it for the notebook', async () => {
        const { controllers, runner } = makeControllers([{ name: 'local', host: 'h' }]);
        const controller = Object.values(controllersById)[0];
        controller.createNotebookCellExecution.mockImplementation(() => makeExecution());
        (vscode.window.showInputBox as jest.Mock).mockResolvedValue('2026-01-01');

        const cell = makeCell('SELECT count() FROM events WHERE d >= {start:Date}');
        await controller.executeHandler!([cell], notebook, controller);
        await controller.executeHandler!([cell], notebook, controller);

        expect(vscode.window.showInputBox).toHaveBeenCalledTimes(1);
        // And the value is handed to the server as a parameter, never spliced
        // into the SQL - that is what stops a typed date being an injection.
        expect(runner.run).toHaveBeenLastCalledWith(
            expect.objectContaining({
                sql: 'SELECT count() FROM events WHERE d >= {start:Date}',
                parameters: { start: '2026-01-01' },
            }),
            expect.anything()
        );
        controllers.dispose();
    });

    it('runs nothing when the parameter prompt is dismissed', async () => {
        const { controllers, runner } = makeControllers([{ name: 'local', host: 'h' }]);
        const controller = Object.values(controllersById)[0];
        const execution = makeExecution();
        controller.createNotebookCellExecution.mockReturnValue(execution);
        (vscode.window.showInputBox as jest.Mock).mockResolvedValue(undefined);

        await controller.executeHandler!([makeCell('SELECT {x:UInt64}')], notebook, controller);

        expect(runner.run).not.toHaveBeenCalled();
        // Nothing ran, so the cell is marked neither passed nor failed.
        expect(execution.end).toHaveBeenCalledWith(undefined, expect.any(Number));
        controllers.dispose();
    });

    it('does not ask at all for a cell with no placeholders', async () => {
        const { controllers, runner } = makeControllers([{ name: 'local', host: 'h' }]);
        const controller = Object.values(controllersById)[0];
        controller.createNotebookCellExecution.mockReturnValue(makeExecution());

        await controller.executeHandler!([makeCell('SELECT 1')], notebook, controller);

        expect(vscode.window.showInputBox).not.toHaveBeenCalled();
        expect(runner.run).toHaveBeenCalledWith(
            expect.objectContaining({ parameters: {} }),
            expect.anything()
        );
        controllers.dispose();
    });

    it('asks again after the parameters are reset', async () => {
        const { controllers } = makeControllers([{ name: 'local', host: 'h' }]);
        const controller = Object.values(controllersById)[0];
        controller.createNotebookCellExecution.mockImplementation(() => makeExecution());
        (vscode.window.showInputBox as jest.Mock).mockResolvedValue('7');

        const cell = makeCell('SELECT {n:UInt64}');
        await controller.executeHandler!([cell], notebook, controller);
        controllers.clearParameters(notebook);
        await controller.executeHandler!([cell], notebook, controller);

        expect(vscode.window.showInputBox).toHaveBeenCalledTimes(2);
        controllers.dispose();
    });

    it('interrupts by asking the server to stop, not by dropping the socket', async () => {
        const { controllers, runner } = makeControllers([{ name: 'local', host: 'h' }]);
        await Object.values(controllersById)[0].interruptHandler!();
        expect(runner.cancel).toHaveBeenCalled();
        controllers.dispose();
    });

    it('ends an execution the gate refused, rather than leaving the cell spinning', async () => {
        const { controllers, runner } = makeControllers([{ name: 'local', host: 'h' }]);
        const controller = Object.values(controllersById)[0];
        const execution = makeExecution();
        controller.createNotebookCellExecution.mockReturnValue(execution);
        // A refusal means the sink never sees begin or end.
        runner.run.mockImplementation(async () => undefined);

        await controller.executeHandler!([makeCell('INSERT INTO t VALUES (1)')], notebook, controller);

        expect(execution.end).toHaveBeenCalledWith(undefined, expect.any(Number));
        controllers.dispose();
    });

    it('puts a finished result into the cell output for the renderer', async () => {
        const { controllers, runner } = makeControllers([{ name: 'local', host: 'h' }]);
        const controller = Object.values(controllersById)[0];
        const execution = makeExecution();
        controller.createNotebookCellExecution.mockReturnValue(execution);

        runner.run.mockImplementation(async (_target: unknown, sink?: ResultSink) => {
            if (!sink) return undefined;
            sink.begin({ query: 'SELECT 1', profile: 'local', queryId: 'q' }, { onCancel: () => undefined });
            sink.setColumns([{ name: 'n', type: 'UInt64' }]);
            sink.appendRows([['1']], 1);
            sink.end({ elapsedMs: 5 }, false);
            return undefined;
        });

        await controller.executeHandler!([makeCell('SELECT 1')], notebook, controller);

        const output = execution.replaceOutput.mock.calls[0][0] as unknown as vscode.NotebookCellOutput;
        expect(output.items.map(item => item.mime)).toEqual([RESULT_MIME, 'text/plain']);
        const payload = JSON.parse(new TextDecoder().decode(output.items[0].data)) as CellResult;
        expect(payload.rows).toEqual([['1']]);
        expect(payload.columns).toEqual([{ name: 'n', type: 'UInt64' }]);
        expect(execution.end).toHaveBeenCalledWith(true, expect.any(Number));
        controllers.dispose();
    });

    it('reports a failure as an error output, not as an empty result', async () => {
        const { controllers, runner } = makeControllers([{ name: 'local', host: 'h' }]);
        const controller = Object.values(controllersById)[0];
        const execution = makeExecution();
        controller.createNotebookCellExecution.mockReturnValue(execution);

        runner.run.mockImplementation(async (_target: unknown, sink?: ResultSink) => {
            if (!sink) return undefined;
            sink.begin({ query: 'SELECT bad', profile: 'local', queryId: 'q' }, { onCancel: () => undefined });
            sink.fail('Unknown identifier: bad', 47);
            return undefined;
        });

        await controller.executeHandler!([makeCell('SELECT bad')], notebook, controller);

        const output = execution.replaceOutput.mock.calls[0][0] as unknown as vscode.NotebookCellOutput;
        expect(output.items[0].mime).toBe('application/vnd.code.notebook.error');
        expect(new TextDecoder().decode(output.items[0].data)).toContain('code 47');
        expect(execution.end).toHaveBeenCalledWith(false, expect.any(Number));
        controllers.dispose();
    });
});

describe('the plain-text half of an output', () => {
    it('says something useful without the renderer', () => {
        const text = summaryText({
            header: { query: 'SELECT 1', profile: 'local', queryId: 'q' },
            columns: [{ name: 'n', type: 'UInt64' }, { name: 'name', type: 'String' }],
            rows: [['1', 'a']],
            statistics: { elapsedMs: 12 },
            truncated: false,
        });
        expect(text).toContain('1 row');
        expect(text).toContain('n, name');
        expect(text).toContain('12 ms');
    });

    it('says when the result was cut short', () => {
        const text = summaryText({
            header: { query: 'SELECT 1', profile: 'local', queryId: 'q' },
            columns: [],
            rows: [],
            truncated: true,
        });
        expect(text).toContain('0 rows');
        expect(text).toContain('truncated');
    });
});

describe('registration', () => {
    it('declares outputs transient, so nothing is held for a backup either', () => {
        setConfig({ connections: [] });
        const disposables = registerNotebook(
            new ConnectionManager(makeContext()),
            { run: jest.fn(), cancel: jest.fn() } as unknown as QueryRunner,
            analysisCache
        );
        const call = (vscode.workspace.registerNotebookSerializer as jest.Mock).mock.calls[0];
        expect(call[0]).toBe(NOTEBOOK_TYPE);
        expect(call[2]).toMatchObject({ transientOutputs: true });
        for (const disposable of disposables) disposable.dispose();
    });
});
