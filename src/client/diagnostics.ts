/**
 * A self-contained connection diagnosis.
 *
 * Five rounds of guessing at a host I cannot observe is five too many. This runs
 * inside the extension host and reports, layer by layer, exactly where a request
 * stops: whether the port is reachable at all, which transports answer, and
 * whether the size of the response is what breaks it.
 */
import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';
import { ClickHouseClient } from './httpClient';
import {
    createNodeSender,
    fetchSender,
    HttpSender,
    loadNodeModules,
} from './transport';
import { ResolvedConnection } from './types';

interface Step {
    label: string;
    outcome: string;
    ms: number;
    ok: boolean;
}

async function timed(label: string, run: () => Promise<string>): Promise<Step> {
    const started = Date.now();
    try {
        const outcome = await run();
        return { label, outcome, ms: Date.now() - started, ok: true };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { label, outcome: message, ms: Date.now() - started, ok: false };
    }
}

/** Can the extension host reach the port at all? */
async function tcpCheck(connection: ResolvedConnection): Promise<string> {
    const modules = loadNodeModules();
    const net = modules?.net;
    if (!net) return 'skipped (no node:net in this host)';

    const url = new URL(connection.url);
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));

    return new Promise<string>((resolve, reject) => {
        const socket = net.connect({ host: url.hostname, port }, () => {
            const address = socket.remoteAddress ?? '?';
            socket.destroy();
            resolve(`connected to ${address}:${port}`);
        });
        socket.setTimeout(5000, () => {
            socket.destroy();
            reject(new Error(`timed out connecting to ${url.hostname}:${port}`));
        });
        socket.on('error', error => reject(error));
    });
}

/** Every transport worth trying, named. */
function candidates(): HttpSender[] {
    const modules = loadNodeModules();
    const senders: HttpSender[] = [];
    if (modules?.http && modules?.https) {
        senders.push(createNodeSender({ http: modules.http, https: modules.https }));
        senders.push(createNodeSender({ http: modules.http, https: modules.https }, { usePatchedRequest: true }));
    }
    senders.push(fetchSender);
    return senders;
}

export function registerDiagnosticsCommand(connections: ConnectionManager): vscode.Disposable {
    return vscode.commands.registerCommand('clickhouse.diagnoseConnection', async () => {
        const profileName = connections.activeProfileName();
        const connection = await connections.resolve();
        if (!connection || !profileName) {
            vscode.window.showWarningMessage('ClickHouse: select a connection first.');
            return;
        }

        const channel = vscode.window.createOutputChannel('ClickHouse Diagnostics');
        channel.clear();
        channel.show(true);
        channel.appendLine(`ClickHouse connection diagnosis - ${new Date().toLocaleString()}`);
        channel.appendLine(`profile ${profileName} -> ${connection.url}, database ${connection.database}`);
        channel.appendLine('');

        const report = (step: Step) => {
            channel.appendLine(
                `  ${step.ok ? 'ok  ' : 'FAIL'}  ${step.label.padEnd(46)} ${String(step.ms).padStart(6)}ms  ${step.outcome}`
            );
        };

        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'ClickHouse: diagnosing connection' },
            async () => {
                channel.appendLine('Reachability');
                report(await timed('tcp connect', () => tcpCheck(connection)));
                channel.appendLine('');

                // Sizes chosen to separate "cannot connect" from "cannot stream":
                // a tiny reply fits one buffer, a large one must keep flowing.
                const probes: Array<{ label: string; sql: string; expect: number }> = [
                    { label: 'tiny  (1 row)', sql: 'SELECT 1', expect: 1 },
                    { label: 'small (100 rows)', sql: 'SELECT number FROM numbers(100)', expect: 100 },
                    { label: 'medium (5k rows)', sql: 'SELECT number FROM numbers(5000)', expect: 5000 },
                    { label: 'large (50k rows)', sql: 'SELECT number FROM numbers(50000)', expect: 50000 },
                    {
                        label: 'wide  (1k rows x 9 cols)',
                        sql: `SELECT number, toString(number), today(), [1,2], map('a','b'), tuple(1,2), 1.5, null, 'x' FROM numbers(1000)`,
                        expect: 1000,
                    },
                ];

                for (const sender of candidates()) {
                    channel.appendLine(`Transport: ${sender.name}`);
                    const client = new ClickHouseClient(connection, sender);
                    let broken = false;

                    for (const probe of probes) {
                        if (broken) {
                            channel.appendLine(`  skip  ${probe.label.padEnd(46)}         (previous probe failed)`);
                            continue;
                        }
                        const step = await timed(probe.label, async () => {
                            const result = await client.query(probe.sql, {
                                readOnly: true,
                                maxExecutionTime: 20,
                                timeoutMs: 20000,
                            });
                            if (result.rows.length !== probe.expect) {
                                throw new Error(`expected ${probe.expect} rows, got ${result.rows.length}`);
                            }
                            return `${result.rows.length} rows`;
                        });
                        report(step);
                        if (!step.ok) broken = true;
                    }
                    channel.appendLine('');
                }

                channel.appendLine('If tcp connect fails, the extension host cannot reach the server at all -');
                channel.appendLine('check whether this window is remote (SSH, WSL, dev container), where');
                channel.appendLine('localhost is a different machine from the one the server runs on.');
                channel.appendLine('');
                channel.appendLine('If the tiny probe passes and a larger one fails, the connection is fine and');
                channel.appendLine('the response cannot be streamed - please send this report.');
            }
        );

        vscode.window.showInformationMessage('ClickHouse: diagnosis written to the ClickHouse Diagnostics output.');
    });
}
