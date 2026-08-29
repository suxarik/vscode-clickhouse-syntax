/**
 * Tests for `ClickHouse: Diagnose Connection`.
 *
 * The point of the command is to distinguish "cannot connect" from "cannot
 * stream", so these tests check that a transport which answers a tiny query and
 * then fails on a larger one is reported as exactly that - and that the probes
 * after a failure are skipped rather than repeated.
 */
import * as vscode from 'vscode';
import { registerDiagnosticsCommand } from '../client/diagnostics';
import { ConnectionManager } from '../client/connectionManager';
import { HttpSender, SendRequest, SendResponse } from '../client/transport';

/** The send the stubbed `fetch` transport delegates to, swappable per test. */
const fetchSend = jest.fn();

jest.mock('../client/transport', () => {
    const actual = jest.requireActual('../client/transport');
    return {
        ...actual,
        loadNodeModules: jest.fn(),
        createNodeSender: jest.fn(),
        // Stubbed as well, so a diagnosis in a test never reaches the network.
        fetchSender: { name: 'fetch', send: (request: unknown) => fetchSend(request) },
    };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const transport = require('../client/transport') as {
    loadNodeModules: jest.Mock;
    createNodeSender: jest.Mock;
};

const setConfig = (vscode as unknown as { __setConfig(v: Record<string, unknown>): void }).__setConfig;

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

/** A response body in the format the client reads. */
function body(rows: number, columns = 1): string {
    const names = Array.from({ length: columns }, (_, i) => `c${i}`);
    const lines = [
        JSON.stringify(names),
        JSON.stringify(names.map(() => 'UInt64')),
        ...Array.from({ length: rows }, (_, i) => JSON.stringify(names.map(() => String(i)))),
    ];
    return lines.join('\n') + '\n';
}

function ok(text: string): SendResponse {
    return {
        status: 200,
        ok: true,
        header: () => null,
        text: async () => text,
        chunks: () => undefined,
    };
}

/**
 * A sender that answers with the number of rows the query asked for, unless the
 * query is bigger than `breaksAbove` - which is how a streaming failure looks.
 */
function sender(name: string, breaksAbove = Infinity): HttpSender {
    return {
        name,
        async send(request: SendRequest): Promise<SendResponse> {
            const match = /numbers\((\d+)\)/.exec(request.body);
            const rows = match ? Number(match[1]) : 1;
            if (rows > breaksAbove) throw new Error('socket hang up');
            return ok(body(rows, /toString/.test(request.body) ? 9 : 1));
        },
    };
}

/** The lines the command wrote to its output channel. */
function captureChannel(): { lines: string[] } {
    const lines: string[] = [];
    (vscode.window.createOutputChannel as jest.Mock).mockReturnValue({
        clear: jest.fn(),
        show: jest.fn(),
        appendLine: jest.fn((line: string) => void lines.push(line)),
        dispose: jest.fn(),
    });
    return { lines };
}

/** Register the command and hand back its handler. */
function diagnoseCommand() {
    const manager = new ConnectionManager(makeContext());
    let handler: (() => Promise<void>) | undefined;
    (vscode.commands.registerCommand as jest.Mock).mockImplementation((_name: string, fn: () => Promise<void>) => {
        handler = fn;
        return { dispose: jest.fn() };
    });
    registerDiagnosticsCommand(manager);
    return { run: () => handler!(), manager };
}

beforeEach(() => {
    jest.clearAllMocks();
    (vscode as unknown as { __resetConfig(): void }).__resetConfig();
    (vscode.workspace as unknown as { isTrusted: boolean }).isTrusted = true;
    setConfig({ connections: [{ name: 'local', host: 'localhost', port: 18123 }] });
    transport.loadNodeModules.mockReturnValue(undefined);
    transport.createNodeSender.mockImplementation(() => sender('node:http'));
    fetchSend.mockImplementation((request: SendRequest) => sender('fetch').send(request));
});

describe('diagnose connection', () => {
    it('asks for a connection first, rather than diagnosing nothing', async () => {
        setConfig({ connections: [] });
        const { run } = diagnoseCommand();
        await run();
        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('select a connection'));
        expect(vscode.window.createOutputChannel).not.toHaveBeenCalled();
    });

    it('names the profile and the URL it is diagnosing', async () => {
        const { lines } = captureChannel();
        await diagnoseCommand().run();
        expect(lines.join('\n')).toContain('profile local -> http://localhost:18123, database default');
    });

    it('reports every probe as ok when the transport works', async () => {
        const { lines } = captureChannel();
        await diagnoseCommand().run();

        const probes = lines.filter(line => /^\s{2}(ok|FAIL|skip)/.test(line));
        expect(probes.length).toBeGreaterThan(0);
        expect(probes.every(line => line.trimStart().startsWith('ok'))).toBe(true);
        expect(lines.join('\n')).toContain('50000 rows');
    });

    it('separates a connection that works from a response that cannot be streamed', async () => {
        fetchSend.mockImplementation((request: SendRequest) => sender('fetch', 100).send(request));
        const { lines } = captureChannel();
        await diagnoseCommand().run();

        const text = lines.join('\n');
        // The tiny and small probes pass; the medium one is where it breaks.
        expect(text).toMatch(/ok\s+tiny\s+\(1 row\)/);
        expect(text).toMatch(/FAIL\s+medium \(5k rows\)/);
        // And it does not keep hammering a transport that has already failed.
        expect(text).toMatch(/skip\s+large \(50k rows\)/);
        expect(text).toContain('previous probe failed');
    });

    it('reports a wrong row count as a failure, not a pass', async () => {
        // A transport that answers, but with the wrong thing, is not working.
        fetchSend.mockImplementation(async () => ok(body(1)));
        const { lines } = captureChannel();
        await diagnoseCommand().run();

        expect(lines.join('\n')).toMatch(/FAIL\s+small \(100 rows\).*expected 100 rows, got 1/);
    });

    it('says the port check was skipped when there is no node:net', async () => {
        const { lines } = captureChannel();
        await diagnoseCommand().run();
        expect(lines.join('\n')).toContain('skipped (no node:net in this host)');
    });

    it('reports the address it reached when the port answers', async () => {
        transport.loadNodeModules.mockReturnValue({
            net: {
                connect: (_options: unknown, callback: () => void) => {
                    const socket = {
                        remoteAddress: '::1',
                        destroy: jest.fn(),
                        setTimeout: jest.fn(),
                        on: jest.fn(),
                    };
                    setTimeout(callback, 0);
                    return socket;
                },
            },
        });
        const { lines } = captureChannel();
        await diagnoseCommand().run();
        // Which address family answered is the whole point - a server listening
        // only on IPv4 while localhost resolves to ::1 is the failure this exists to show.
        expect(lines.join('\n')).toContain('connected to ::1:18123');
    });

    it('reports a refused port as a failure', async () => {
        transport.loadNodeModules.mockReturnValue({
            net: {
                connect: () => ({
                    remoteAddress: undefined,
                    destroy: jest.fn(),
                    setTimeout: jest.fn(),
                    on: (event: string, handler: (error: Error) => void) => {
                        if (event === 'error') setTimeout(() => handler(new Error('ECONNREFUSED')), 0);
                    },
                }),
            },
        });
        const { lines } = captureChannel();
        await diagnoseCommand().run();
        expect(lines.join('\n')).toMatch(/FAIL\s+tcp connect.*ECONNREFUSED/);
    });

    it('tries both node transports as well as fetch when Node is available', async () => {
        transport.loadNodeModules.mockReturnValue({ http: {}, https: {}, net: undefined });
        let made = 0;
        transport.createNodeSender.mockImplementation(() => sender(`node:http #${++made}`));
        const { lines } = captureChannel();
        await diagnoseCommand().run();

        expect(made).toBe(2);
        const headings = lines.filter(line => line.startsWith('Transport: '));
        expect(headings).toHaveLength(3);
        expect(headings[2]).toBe('Transport: fetch');
    });

    it('explains how to read the report, so it is useful without us', async () => {
        const { lines } = captureChannel();
        await diagnoseCommand().run();
        const text = lines.join('\n');
        expect(text).toContain('the extension host cannot reach the server at all');
        expect(text).toContain('SSH, WSL, dev container');
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('diagnosis'));
    });
});
