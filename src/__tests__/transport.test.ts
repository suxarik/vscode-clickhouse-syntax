/**
 * Tests for the Node HTTP sender, against a real server on a real socket.
 *
 * These deliberately do not stub anything: the reason this sender exists is
 * that a stubbed `fetch` proved nothing about how requests actually leave the
 * process.
 */
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { createFallbackSender, createNodeSender, createSender, fetchSender, HttpSender } from '../client/transport';
import { ClickHouseClient } from '../client/httpClient';
import { ResolvedConnection } from '../client/types';

const sender = createNodeSender({ http, https: http } as never);

let server: http.Server;
let base: string;
let received: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string }>;
let handler: (request: http.IncomingMessage, response: http.ServerResponse, body: string) => void;

beforeAll(async () => {
    received = [];
    server = http.createServer((request, response) => {
        let body = '';
        request.on('data', chunk => {
            body += chunk;
        });
        request.on('end', () => {
            received.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers, body });
            handler(request, response, body);
        });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
});

beforeEach(() => {
    received = [];
    handler = (_request, response) => {
        response.writeHead(200, { 'Content-Type': 'text/plain' });
        response.end('ok');
    };
});

describe('node sender', () => {
    it('sends the method, headers and body', async () => {
        await sender.send({
            url: `${base}/?database=analytics`,
            method: 'POST',
            headers: { 'X-ClickHouse-User': 'default' },
            body: 'SELECT 1',
        });

        expect(received[0].method).toBe('POST');
        expect(received[0].url).toBe('/?database=analytics');
        expect(received[0].headers['x-clickhouse-user']).toBe('default');
        expect(received[0].body).toBe('SELECT 1');
    });

    it('sets Content-Length, which Node does not add for a string body', async () => {
        await sender.send({ url: base, method: 'POST', headers: {}, body: 'SELECT 1' });
        expect(received[0].headers['content-length']).toBe('8');
    });

    it('handles a body with multi-byte characters', async () => {
        const body = "SELECT 'héllo wörld ☃'";
        await sender.send({ url: base, method: 'POST', headers: {}, body });
        // Byte length, not character length — otherwise the request truncates.
        expect(received[0].body).toBe(body);
        expect(received[0].headers['content-length']).toBe(String(Buffer.byteLength(body)));
    });

    it('reports the status and headers', async () => {
        handler = (_request, response) => {
            response.writeHead(404, { 'X-ClickHouse-Summary': '{"read_rows":"7"}' });
            response.end('nope');
        };
        const response = await sender.send({ url: base, method: 'POST', headers: {}, body: '' });
        expect(response.status).toBe(404);
        expect(response.ok).toBe(false);
        expect(response.header('X-ClickHouse-Summary')).toBe('{"read_rows":"7"}');
        expect(response.header('X-Nothing')).toBeNull();
    });

    it('reads the body as text', async () => {
        expect(await (await sender.send({ url: base, method: 'POST', headers: {}, body: '' })).text()).toBe('ok');
    });

    it('streams the body in chunks', async () => {
        handler = (_request, response) => {
            response.writeHead(200);
            response.write('first\n');
            response.write('second\n');
            response.end();
        };
        const response = await sender.send({ url: base, method: 'POST', headers: {}, body: '' });
        const stream = response.chunks();
        expect(stream).toBeDefined();

        let text = '';
        for await (const chunk of stream!) text += new TextDecoder().decode(chunk);
        expect(text).toBe('first\nsecond\n');
    });

    it('rejects when nothing is listening', async () => {
        await expect(
            sender.send({ url: 'http://127.0.0.1:1/', method: 'POST', headers: {}, body: '' })
        ).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    });

    it('survives many sequential requests on one sender', async () => {
        // The bug that prompted this sender showed up as every second request
        // timing out, so a single round trip proves nothing.
        for (let i = 0; i < 25; i++) {
            const response = await sender.send({ url: base, method: 'POST', headers: {}, body: `q${i}` });
            expect(response.status).toBe(200);
            expect(await response.text()).toBe('ok');
        }
        expect(received).toHaveLength(25);
    });

    it('survives many streamed requests on one sender', async () => {
        handler = (_request, response) => {
            response.writeHead(200);
            response.end('line\n');
        };
        for (let i = 0; i < 25; i++) {
            const response = await sender.send({ url: base, method: 'POST', headers: {}, body: `q${i}` });
            let text = '';
            for await (const chunk of response.chunks()!) text += new TextDecoder().decode(chunk);
            expect(text).toBe('line\n');
        }
    });
});

describe('the client over a real socket', () => {
    function connection(): ResolvedConnection {
        return {
            name: 'real',
            url: base,
            user: 'default',
            database: 'analytics',
            allowWrite: false,
            isProtected: false,
            auth: 'password',
            allowInvalidCertificate: false,
            settings: {},
        };
    }

    it('reads a result end to end', async () => {
        handler = (_request, response) => {
            response.writeHead(200);
            response.end('["n","s"]\n["UInt64","String"]\n["1","alpha"]\n["2","beta"]\n');
        };
        const result = await new ClickHouseClient(connection(), sender).query('SELECT n, s FROM t');
        expect(result.columns).toEqual([
            { name: 'n', type: 'UInt64' },
            { name: 's', type: 'String' },
        ]);
        expect(result.rows).toEqual([
            ['1', 'alpha'],
            ['2', 'beta'],
        ]);
    });

    it('turns a server error into a ClickHouseError', async () => {
        handler = (_request, response) => {
            response.writeHead(404);
            response.end('Code: 60. DB::Exception: Table t does not exist.');
        };
        await expect(new ClickHouseClient(connection(), sender).query('SELECT 1')).rejects.toMatchObject({
            code: 60,
        });
    });

    it('runs repeatedly without a stale connection', async () => {
        handler = (_request, response) => {
            response.writeHead(200);
            response.end('["n"]\n["UInt64"]\n["1"]\n');
        };
        const client = new ClickHouseClient(connection(), sender);
        for (let i = 0; i < 20; i++) {
            expect((await client.query('SELECT 1')).rows).toEqual([['1']]);
        }
    });

    it('explains a refused connection rather than saying "fetch failed"', async () => {
        const offline = { ...connection(), url: 'http://127.0.0.1:1' };
        await expect(new ClickHouseClient(offline, sender).query('SELECT 1')).rejects.toThrow(
            /Nothing is listening/
        );
    });
});

describe('sender selection', () => {
    it('offers every candidate, preferring the unpatchable one', () => {
        // Which of these the desktop host has broken varies, so all three are
        // kept and the first that answers is remembered.
        expect(createSender().name).toBe('node:http (direct) → node:http → fetch');
    });

    it('has a fetch sender for the web build', () => {
        expect(fetchSender.name).toBe('fetch');
    });
});

describe('cancellation and deadlines', () => {
    it('cancels an in-flight request through the signal', async () => {
        handler = () => {
            // Never respond, so only the abort can end this.
        };
        const controller = new AbortController();
        const pending = sender.send({
            url: base,
            method: 'POST',
            headers: {},
            body: '',
            signal: controller.signal,
        });
        setTimeout(() => controller.abort(), 20);
        await expect(pending).rejects.toMatchObject({ code: 'ABORT_ERR' });
    });

    it('gives up on a server that never responds', async () => {
        handler = () => {
            // Silence. Without a deadline this would hang forever, which is
            // exactly the failure that left the results panel blank.
        };
        await expect(
            sender.send({ url: base, method: 'POST', headers: {}, body: '', timeoutMs: 100 })
        ).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    });

    it('does not fire the deadline for a request that answers', async () => {
        const response = await sender.send({
            url: base,
            method: 'POST',
            headers: {},
            body: '',
            timeoutMs: 2000,
        });
        expect(response.status).toBe(200);
        expect(await response.text()).toBe('ok');
    });

    it('rejects immediately when the signal is already aborted', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(
            sender.send({ url: base, method: 'POST', headers: {}, body: '', signal: controller.signal })
        ).rejects.toMatchObject({ code: 'ABORT_ERR' });
    });
});

describe('bypassing a patched request function', () => {
    it('constructs a ClientRequest directly when the class is available', () => {
        // The desktop host wraps `http.request`; the class behind it is not
        // wrapped, so that is what the sender reaches for.
        expect(createNodeSender({ http, https: http } as never).name).toBe('node:http (direct)');
    });

    it('falls back to request() when the class is missing', () => {
        const withoutClass = { request: http.request } as never;
        expect(createNodeSender({ http: withoutClass, https: withoutClass }).name).toBe('node:http');
    });

    it('works either way against a real server', async () => {
        for (const usePatchedRequest of [false, true]) {
            const under = createNodeSender({ http, https: http } as never, { usePatchedRequest });
            const response = await under.send({ url: base, method: 'POST', headers: {}, body: 'x' });
            expect(response.status).toBe(200);
            expect(await response.text()).toBe('ok');
        }
    });

    it('streams a large body, not just a small one', async () => {
        // Small replies fit in one buffer and can succeed while streaming is
        // broken, so this deliberately spans many chunks.
        const line = `${'x'.repeat(500)}\n`;
        handler = (_request, response) => {
            response.writeHead(200);
            for (let i = 0; i < 500; i++) response.write(line);
            response.end();
        };
        const response = await sender.send({ url: base, method: 'POST', headers: {}, body: '' });
        let bytes = 0;
        for await (const chunk of response.chunks()!) bytes += chunk.length;
        expect(bytes).toBe(line.length * 500);
    });
});

describe('transport fallback', () => {
    /** A transport that always fails, to stand in for a broken one. */
    function broken(name: string): HttpSender {
        return {
            name,
            send: async () => {
                throw Object.assign(new Error('never answered'), { code: 'ETIMEDOUT' });
            },
        };
    }

    it('uses the first transport that answers', async () => {
        const composite = createFallbackSender([broken('a'), broken('b'), sender]);
        const response = await composite.send({ url: base, method: 'POST', headers: {}, body: '' });
        expect(response.status).toBe(200);
        expect(await response.text()).toBe('ok');
    });

    it('sticks with the one that worked', async () => {
        const attempts: string[] = [];
        const composite = createFallbackSender([broken('a'), sender]);
        await composite.send({ url: base, method: 'POST', headers: {}, body: '', onTrace: n => attempts.push(n) });

        const afterFirst = attempts.length;
        await composite.send({ url: base, method: 'POST', headers: {}, body: '', onTrace: n => attempts.push(n) });
        // The second call goes straight to the winner, with nothing to report.
        expect(attempts.length).toBe(afterFirst);
    });

    it('names the transport that answered', async () => {
        const composite = createFallbackSender([broken('a'), sender]);
        expect(composite.name).toContain('→');
        await composite.send({ url: base, method: 'POST', headers: {}, body: '' });
        expect(composite.name).toBe(sender.name);
    });

    it('reports every failure when none work', async () => {
        const composite = createFallbackSender([broken('a'), broken('b')]);
        await expect(
            composite.send({ url: base, method: 'POST', headers: {}, body: '' })
        ).rejects.toThrow(/No usable HTTP transport.*a:.*b:/s);
    });

    it('splits the deadline so one hang cannot use it all', async () => {
        handler = () => {
            // Never responds.
        };
        const started = Date.now();
        await expect(
            createFallbackSender([sender, sender]).send({
                url: base,
                method: 'POST',
                headers: {},
                body: '',
                timeoutMs: 6000,
            })
        ).rejects.toThrow(/No usable HTTP transport/);
        // Two candidates sharing 6s must not take 12s.
        expect(Date.now() - started).toBeLessThan(9000);
    }, 15000);

    it('does not fall through once a response exists', async () => {
        handler = (_request, response) => {
            response.writeHead(500);
            response.end('server error');
        };
        // A 500 is an answer, not a transport failure.
        const composite = createFallbackSender([sender, broken('never-used')]);
        const response = await composite.send({ url: base, method: 'POST', headers: {}, body: '' });
        expect(response.status).toBe(500);
    });
});

describe('address family selection', () => {
    it('races IPv4 and IPv6 rather than committing to the first address', async () => {
        // `localhost` resolves to ::1 first, and a host reachable only on IPv4
        // would otherwise hang instead of falling back.
        const seen: Array<Record<string, unknown>> = [];
        const recording = {
            ClientRequest: function (_url: string, options: Record<string, unknown>) {
                seen.push(options);
                return {
                    on: () => undefined,
                    write: () => undefined,
                    end: () => undefined,
                    destroy: () => undefined,
                };
            },
        } as never;

        const under = createNodeSender({ http: recording, https: recording });
        void under.send({ url: 'http://localhost:1/', method: 'POST', headers: {}, body: '' });

        expect(seen[0].autoSelectFamily).toBe(true);
        expect(seen[0].autoSelectFamilyAttemptTimeout).toBe(500);
    });

    it('reaches a server bound only to IPv4 via localhost', async () => {
        // The test server binds 127.0.0.1 only, so this fails outright without
        // the family race.
        const response = await sender.send({
            url: base.replace('127.0.0.1', 'localhost'),
            method: 'POST',
            headers: {},
            body: '',
        });
        expect(response.status).toBe(200);
    });
});

describe('certificate handling', () => {
    /** Capture the options handed to the request. */
    function recordingSender() {
        const seen: Array<Record<string, unknown>> = [];
        const recording = {
            ClientRequest: function (_url: string, options: Record<string, unknown>) {
                seen.push(options);
                return { on: () => undefined, write: () => undefined, end: () => undefined, destroy: () => undefined };
            },
        } as never;
        return { seen, sender: createNodeSender({ http: recording, https: recording }) };
    }

    it('verifies certificates by default', () => {
        const { seen, sender: under } = recordingSender();
        void under.send({ url: 'https://example:8443/', method: 'POST', headers: {}, body: '' });
        expect(seen[0].rejectUnauthorized).toBeUndefined();
    });

    it('only skips verification when the profile opts in', () => {
        const { seen, sender: under } = recordingSender();
        void under.send({
            url: 'https://example:8443/',
            method: 'POST',
            headers: {},
            body: '',
            allowInvalidCertificate: true,
        });
        expect(seen[0].rejectUnauthorized).toBe(false);
    });
});
