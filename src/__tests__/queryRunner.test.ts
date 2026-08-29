/**
 * Tests for running a statement, and for the safety gate that guards it.
 */
import * as vscode from 'vscode';
import { QueryRunner, resolveTarget } from '../client/queryRunner';
import { ConnectionManager } from '../client/connectionManager';
import { ResultsPanel } from '../results/resultsPanel';
import { AnalysisCache } from '../analysis';
import { makeSchemaManager, makeCatalog, docAt } from './helpers';

const ROWS = ['["n"]', '["UInt64"]', '["1"]', ''].join('\n');

let requests: Array<{ url: string; body: string }> = [];

function stubFetch(body = ROWS, status = 200): void {
    requests = [];
    (globalThis as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string, init: RequestInit) => {
        requests.push({ url: String(url), body: String(init.body ?? '') });
        const encoder = new TextEncoder();
        let sent = false;
        return {
            ok: status >= 200 && status < 300,
            status,
            headers: { get: () => null },
            text: async () => body,
            body: {
                getReader: () => ({
                    read: async () => {
                        if (sent) return { done: true, value: undefined };
                        sent = true;
                        return { done: false, value: encoder.encode(body) };
                    },
                    cancel: async () => undefined,
                }),
            },
        };
    });
}

function makeContext() {
    const state: Record<string, unknown> = {};
    const secrets = new Map<string, string>();
    return {
        subscriptions: [],
        extensionUri: vscode.Uri.file('/ext'),
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
    } as unknown as vscode.ExtensionContext;
}

function setConfig(values: Record<string, unknown>): void {
    (vscode as unknown as { __setConfig(v: Record<string, unknown>): void }).__setConfig(values);
}

let analysisCache: AnalysisCache;

beforeAll(async () => {
    analysisCache = new AnalysisCache(await makeSchemaManager(), makeCatalog());
});

beforeEach(() => {
    jest.clearAllMocks();
    (vscode as unknown as { __resetConfig(): void }).__resetConfig();
    (vscode.workspace as unknown as { isTrusted: boolean }).isTrusted = true;
    stubFetch();
});

/** A runner wired to a single profile with the given flags. */
function makeRunner(profile: Record<string, unknown> = {}) {
    setConfig({ connections: [{ name: 'prof', host: 'localhost', ...profile }] });
    const context = makeContext();
    const connections = new ConnectionManager(context);
    const panel = new ResultsPanel(vscode.Uri.file('/ext'));
    return { runner: new QueryRunner(connections, panel, analysisCache), connections, panel };
}

function target(sql: string) {
    const { document } = docAt(sql);
    const start = new vscode.Position(0, 0);
    return resolveTarget(document, new vscode.Selection(start, start), analysisCache)!;
}

describe('resolveTarget', () => {
    it('takes the statement under the cursor', () => {
        const { document } = docAt('SELECT 1;\nSELECT 2;');
        const position = document.positionAt(document.getText().indexOf('SELECT 2'));
        const resolved = resolveTarget(document, new vscode.Selection(position, position), analysisCache);
        // The statement range stops before the separator, so the `;` is not sent.
        expect(resolved?.sql).toBe('SELECT 2');
        expect(resolved?.statements).toHaveLength(1);
    });

    it('takes the selection when there is one', () => {
        const { document } = docAt('SELECT 1;\nSELECT 2;');
        const from = document.positionAt(0);
        const to = document.positionAt(8);
        const resolved = resolveTarget(document, new vscode.Selection(from, to), analysisCache);
        expect(resolved?.sql).toBe('SELECT 1');
    });

    it('classifies the selection, not the whole document', () => {
        const { document } = docAt('SELECT 1;\nDROP TABLE t;');
        const from = document.positionAt(0);
        const to = document.positionAt(8);
        const resolved = resolveTarget(document, new vscode.Selection(from, to), analysisCache);
        expect(resolved?.statements).toHaveLength(1);
        expect(resolved?.statements[0].kind).toBe('SelectStatement');
    });

    it('falls back to the preceding statement in trailing whitespace', () => {
        const { document } = docAt('SELECT 1;\n\n');
        const end = document.positionAt(document.getText().length);
        expect(resolveTarget(document, new vscode.Selection(end, end), analysisCache)?.sql).toBe('SELECT 1');
    });

    it('returns nothing for an empty document', () => {
        const { document } = docAt('   ');
        const start = new vscode.Position(0, 0);
        expect(resolveTarget(document, new vscode.Selection(start, start), analysisCache)).toBeUndefined();
    });
});

describe('the safety gate', () => {
    it('runs a read without asking', async () => {
        const { runner } = makeRunner();
        await runner.run(target('SELECT 1'));
        expect(requests).toHaveLength(1);
        expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    });

    it('refuses a write on a read-only profile and sends nothing', async () => {
        const { runner } = makeRunner();
        await runner.run(target('INSERT INTO t VALUES (1)'));
        expect(requests).toHaveLength(0);
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('read-only'));
    });

    it('refuses a destructive statement on a read-only profile', async () => {
        const { runner } = makeRunner();
        await runner.run(target('DROP TABLE t'));
        expect(requests).toHaveLength(0);
    });

    it('asks before a write on a writable profile', async () => {
        (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Run');
        const { runner } = makeRunner({ allowWrite: true });
        await runner.run(target('INSERT INTO t VALUES (1)'));
        expect(vscode.window.showWarningMessage).toHaveBeenCalled();
        expect(requests).toHaveLength(1);
    });

    it('sends nothing when the confirmation is declined', async () => {
        (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);
        const { runner } = makeRunner({ allowWrite: true });
        await runner.run(target('INSERT INTO t VALUES (1)'));
        expect(requests).toHaveLength(0);
    });

    it('requires the profile name typed on a protected profile', async () => {
        (vscode.window.showInputBox as jest.Mock).mockResolvedValue('prof');
        const { runner } = makeRunner({ allowWrite: true, protected: true });
        await runner.run(target('DROP TABLE t'));
        expect(vscode.window.showInputBox).toHaveBeenCalled();
        expect(requests).toHaveLength(1);
    });

    it('sends nothing when the typed confirmation is wrong', async () => {
        (vscode.window.showInputBox as jest.Mock).mockResolvedValue('something else');
        const { runner } = makeRunner({ allowWrite: true, protected: true });
        await runner.run(target('DROP TABLE t'));
        expect(requests).toHaveLength(0);
    });

    it('never prompts its way past a read-only profile', async () => {
        (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Run');
        (vscode.window.showInputBox as jest.Mock).mockResolvedValue('prof');
        const { runner } = makeRunner({ protected: true });
        await runner.run(target('DROP TABLE t'));
        expect(requests).toHaveLength(0);
    });
});

describe('what reaches the server', () => {
    it('tells the server the query is read-only on a read-only profile', async () => {
        const { runner } = makeRunner();
        await runner.run(target('SELECT 1'));
        expect(new URL(requests[0].url).searchParams.get('readonly')).toBe('2');
    });

    it('does not send readonly on a writable profile', async () => {
        const { runner } = makeRunner({ allowWrite: true });
        await runner.run(target('SELECT 1'));
        expect(new URL(requests[0].url).searchParams.get('readonly')).toBeNull();
    });

    it('applies the configured row and time limits', async () => {
        setConfig({
            connections: [{ name: 'prof', host: 'localhost' }],
            'query.maxResultRows': 500,
            'query.maxExecutionTime': 15,
        });
        const context = makeContext();
        const connections = new ConnectionManager(context);
        const runner = new QueryRunner(connections, new ResultsPanel(vscode.Uri.file('/ext')), analysisCache);
        await runner.run(target('SELECT 1'));
        const params = new URL(requests[0].url).searchParams;
        expect(params.get('max_result_rows')).toBe('501');
        expect(params.get('max_execution_time')).toBe('15');
    });

    it('sends the statement itself', async () => {
        const { runner } = makeRunner();
        await runner.run(target('SELECT 1'));
        expect(requests[0].body).toContain('SELECT 1');
    });
});

describe('no connection', () => {
    it('offers to pick one rather than failing silently', async () => {
        setConfig({ connections: [] });
        const connections = new ConnectionManager(makeContext());
        const runner = new QueryRunner(connections, new ResultsPanel(vscode.Uri.file('/ext')), analysisCache);
        (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Select Connection');

        await runner.run(target('SELECT 1'));
        expect(requests).toHaveLength(0);
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith('clickhouse.selectConnection');
    });
});

describe('errors', () => {
    it('reports a server error without throwing', async () => {
        stubFetch('Code: 60. DB::Exception: Table t does not exist.', 404);
        const { runner } = makeRunner();
        await expect(runner.run(target('SELECT 1 FROM t'))).resolves.toBeUndefined();
    });
});

describe('cancellation', () => {
    it('is a no-op when nothing is running', async () => {
        const { runner } = makeRunner();
        expect(runner.isRunning).toBe(false);
        await expect(runner.cancel()).resolves.toBeUndefined();
    });

    it('asks the server to kill the query', async () => {
        const { runner } = makeRunner();
        // Hold the response open so the query is still running when we cancel.
        let release: () => void = () => undefined;
        const held = new Promise<void>(resolve => (release = resolve));
        (globalThis as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string, init: RequestInit) => {
            requests.push({ url: String(url), body: String(init.body ?? '') });
            if (String(init.body).startsWith('KILL QUERY')) {
                return { ok: true, status: 200, headers: { get: () => null }, text: async () => '', body: null };
            }
            await held;
            return {
                ok: true,
                status: 200,
                headers: { get: () => null },
                text: async () => ROWS,
                body: null,
            };
        });

        const running = runner.run(target('SELECT 1'));
        // The gate and credential lookup are async, so wait for the request to start.
        for (let i = 0; i < 50 && !runner.isRunning; i++) await Promise.resolve();
        expect(runner.isRunning).toBe(true);

        await runner.cancel();
        release();
        await running;

        expect(requests.some(request => request.body.startsWith('KILL QUERY'))).toBe(true);
    });
});

describe('what the panel is told', () => {
    /** Capture the messages the panel would send to the view. */
    function capturingPanel() {
        const panel = new ResultsPanel(vscode.Uri.file('/ext'));
        const messages: Array<{ type: string; rows?: number }> = [];
        (panel as unknown as { send(m: { type: string; rows?: unknown[] }): void }).send = m =>
            messages.push({ type: m.type, rows: m.rows?.length });
        return { panel, messages };
    }

    it('begins once and streams the rows once', async () => {
        setConfig({ connections: [{ name: 'prof', host: 'localhost' }] });
        const connections = new ConnectionManager(makeContext());
        const { panel, messages } = capturingPanel();
        const runner = new QueryRunner(connections, panel, analysisCache);

        await runner.run(target('SELECT 1'));

        // A second `begin` would reset the view and re-send every row.
        expect(messages.filter(m => m.type === 'begin')).toHaveLength(1);
        expect(messages.filter(m => m.type === 'columns')).toHaveLength(1);
        expect(messages.filter(m => m.type === 'rows').reduce((n, m) => n + (m.rows ?? 0), 0)).toBe(1);
        expect(messages.filter(m => m.type === 'end')).toHaveLength(1);
    });
});
