/**
 * Tests for the Node HTTP sender, against a real server on a real socket.
 *
 * These deliberately do not stub anything: the reason this sender exists is
 * that a stubbed `fetch` proved nothing about how requests actually leave the
 * process.
 */
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { createNodeSender, createSender, fetchSender } from '../client/transport';
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
    it('prefers Node http where it exists', () => {
        // In this environment Node's modules are present, so the desktop path
        // is what gets chosen.
        expect(createSender().name).toBe('node:http');
    });

    it('has a fetch sender for the web build', () => {
        expect(fetchSender.name).toBe('fetch');
    });
});
