/**
 * Tests for the ClickHouse HTTP client, against a stubbed fetch.
 */
import { prepareStatement, ClickHouseClient, newQueryId, parseServerError, parseSummary } from '../client/httpClient';
import { ClickHouseError, ResolvedConnection } from '../client/types';

const CONNECTION: ResolvedConnection = {
    name: 'test',
    url: 'http://ch.example:8123',
    user: 'reader',
    password: 'secret',
    database: 'analytics',
    allowWrite: false,
    isProtected: false,
    auth: 'password',
    allowInvalidCertificate: false,
    settings: {},
};

interface Call {
    url: string;
    init: RequestInit;
}

let calls: Call[] = [];

/** Stub fetch with a body and headers. */
function stubFetch(body: string, init: { status?: number; headers?: Record<string, string> } = {}): void {
    calls = [];
    (globalThis as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string, requestInit: RequestInit) => {
        calls.push({ url: String(url), init: requestInit });
        const status = init.status ?? 200;
        const headers = new Map(Object.entries(init.headers ?? {}));
        const encoder = new TextEncoder();
        // Deliver the body in small chunks so the streaming path is exercised.
        const chunks: Uint8Array[] = [];
        for (let i = 0; i < body.length; i += 7) chunks.push(encoder.encode(body.slice(i, i + 7)));
        let index = 0;

        return {
            ok: status >= 200 && status < 300,
            status,
            headers: { get: (name: string) => headers.get(name) ?? null },
            text: async () => body,
            body: {
                getReader: () => ({
                    read: async () =>
                        index < chunks.length ? { done: false, value: chunks[index++] } : { done: true, value: undefined },
                    cancel: async () => undefined,
                    releaseLock: () => undefined,
                }),
            },
        };
    });
}

const NAMES_TYPES_ROWS = [
    '["id","name"]',
    '["UInt64","String"]',
    '[1,"alpha"]',
    '[2,"beta"]',
    '',
].join('\n');

function query() {
    return new URL(calls[0].url).searchParams;
}

describe('request shape', () => {
    it('posts the statement with the streaming format appended', async () => {
        stubFetch(NAMES_TYPES_ROWS);
        await new ClickHouseClient(CONNECTION).query('SELECT id, name FROM t');
        expect(calls[0].init.method).toBe('POST');
        expect(String(calls[0].init.body)).toContain('SELECT id, name FROM t');
        expect(String(calls[0].init.body)).toContain('FORMAT JSONCompactEachRowWithNamesAndTypes');
    });

    it('sends credentials in headers, never the URL', async () => {
        stubFetch(NAMES_TYPES_ROWS);
        await new ClickHouseClient(CONNECTION).query('SELECT 1');
        const headers = calls[0].init.headers as Record<string, string>;
        expect(headers['X-ClickHouse-User']).toBe('reader');
        expect(headers['X-ClickHouse-Key']).toBe('secret');
        expect(calls[0].url).not.toContain('secret');
        expect(calls[0].url).not.toContain('password');
    });

    it('omits the key header when there is no password', async () => {
        stubFetch(NAMES_TYPES_ROWS);
        await new ClickHouseClient({ ...CONNECTION, password: undefined }).query('SELECT 1');
        expect(calls[0].init.headers as Record<string, string>).not.toHaveProperty('X-ClickHouse-Key');
    });

    it('sends the profile database', async () => {
        stubFetch(NAMES_TYPES_ROWS);
        await new ClickHouseClient(CONNECTION).query('SELECT 1');
        expect(query().get('database')).toBe('analytics');
    });

    it('lets a query override the database', async () => {
        stubFetch(NAMES_TYPES_ROWS);
        await new ClickHouseClient(CONNECTION).query('SELECT 1', { database: 'system' });
        expect(query().get('database')).toBe('system');
    });

    it('sends readonly=2 when asked, so the server enforces it too', async () => {
        stubFetch(NAMES_TYPES_ROWS);
        await new ClickHouseClient(CONNECTION).query('SELECT 1', { readOnly: true });
        expect(query().get('readonly')).toBe('2');
    });

    it('does not send readonly when writes are permitted', async () => {
        stubFetch(NAMES_TYPES_ROWS);
        await new ClickHouseClient(CONNECTION).query('SELECT 1', { readOnly: false });
        expect(query().get('readonly')).toBeNull();
    });

    it('sends a parameter as ClickHouse\'s own param_, not spliced into the SQL', async () => {
        stubFetch(NAMES_TYPES_ROWS);
        const client = new ClickHouseClient(CONNECTION);
        await client.query('SELECT {start:Date}', { parameters: { start: '2026-01-01' } });
        expect(query().get('param_start')).toBe('2026-01-01');
        // Verified against a real server: an unbound one is refused with
        // UNKNOWN_QUERY_PARAMETER rather than silently running wrong.
    });

    it('lets a parameter carry a value that would be an injection if pasted in', async () => {
        stubFetch(NAMES_TYPES_ROWS);
        const client = new ClickHouseClient(CONNECTION);
        await client.query('SELECT {kind:String}', { parameters: { kind: "'; DROP TABLE t; --" } });
        expect(query().get('param_kind')).toBe("'; DROP TABLE t; --");
    });

    it('does not let a parameter shadow a profile setting', async () => {
        stubFetch(NAMES_TYPES_ROWS);
        const connection = { ...CONNECTION, settings: { max_threads: '4' } };
        await new ClickHouseClient(connection).query('SELECT 1', { parameters: { max_threads: '99' } });
        expect(query().get('max_threads')).toBe('4');
        expect(query().get('param_max_threads')).toBe('99');
    });

    it('applies row and time limits', async () => {
        stubFetch(NAMES_TYPES_ROWS);
        await new ClickHouseClient(CONNECTION).query('SELECT 1', { maxRows: 1000, maxExecutionTime: 30 });
        // One extra row so the client can tell a full result from a cut one.
        expect(query().get('max_result_rows')).toBe('1001');
        expect(query().get('result_overflow_mode')).toBe('break');
        expect(query().get('max_execution_time')).toBe('30');
    });

    it('passes the query id through so the query can be killed', async () => {
        stubFetch(NAMES_TYPES_ROWS);
        const result = await new ClickHouseClient(CONNECTION).query('SELECT 1', { queryId: 'abc-123' });
        expect(query().get('query_id')).toBe('abc-123');
        expect(result.queryId).toBe('abc-123');
    });

    it('sends profile settings', async () => {
        stubFetch(NAMES_TYPES_ROWS);
        await new ClickHouseClient({ ...CONNECTION, settings: { max_threads: 4 } }).query('SELECT 1');
        expect(query().get('max_threads')).toBe('4');
    });
});

describe('reading results', () => {
    it('reads names, types and rows from the stream', async () => {
        stubFetch(NAMES_TYPES_ROWS);
        const result = await new ClickHouseClient(CONNECTION).query('SELECT id, name FROM t');
        expect(result.columns).toEqual([
            { name: 'id', type: 'UInt64' },
            { name: 'name', type: 'String' },
        ]);
        expect(result.rows).toEqual([
            [1, 'alpha'],
            [2, 'beta'],
        ]);
        expect(result.truncated).toBe(false);
    });

    it('handles an empty result', async () => {
        stubFetch('["id"]\n["UInt64"]\n');
        const result = await new ClickHouseClient(CONNECTION).query('SELECT id FROM t WHERE 0');
        expect(result.columns).toHaveLength(1);
        expect(result.rows).toEqual([]);
    });

    it('reports rows as they arrive', async () => {
        stubFetch(NAMES_TYPES_ROWS);
        const batches: number[] = [];
        await new ClickHouseClient(CONNECTION).query('SELECT 1', {
            onRows: (_rows, total) => batches.push(total),
        });
        expect(batches.length).toBeGreaterThan(0);
        expect(batches[batches.length - 1]).toBe(2);
    });

    it('stops at maxRows and marks the result truncated', async () => {
        stubFetch(NAMES_TYPES_ROWS);
        const result = await new ClickHouseClient(CONNECTION).query('SELECT 1', { maxRows: 1 });
        expect(result.rows).toHaveLength(1);
        expect(result.truncated).toBe(true);
    });

    it('measures elapsed time', async () => {
        stubFetch(NAMES_TYPES_ROWS);
        const result = await new ClickHouseClient(CONNECTION).query('SELECT 1');
        expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    });

    it('survives a truncated final line', async () => {
        stubFetch('["id"]\n["UInt64"]\n[1]\n[2');
        const result = await new ClickHouseClient(CONNECTION).query('SELECT 1');
        expect(result.rows).toEqual([[1]]);
    });
});

describe('errors', () => {
    it('turns a server error into a ClickHouseError', async () => {
        stubFetch('Code: 60. DB::Exception: Table analytics.ghosts does not exist. (UNKNOWN_TABLE)', {
            status: 404,
        });
        await expect(new ClickHouseClient(CONNECTION).query('SELECT 1 FROM ghosts')).rejects.toBeInstanceOf(
            ClickHouseError
        );
    });

    it('extracts the code and message', () => {
        const error = parseServerError(
            'Code: 60. DB::Exception: Table x does not exist. (UNKNOWN_TABLE)\nStack trace:\n  0x1234',
            404
        );
        expect(error.code).toBe(60);
        expect(error.message).toBe('Table x does not exist. (UNKNOWN_TABLE)');
        expect(error.httpStatus).toBe(404);
    });

    it('falls back to the raw body when the shape is unfamiliar', () => {
        const error = parseServerError('something went wrong', 500);
        expect(error.message).toBe('something went wrong');
        expect(error.code).toBeUndefined();
    });

    it('falls back to the status when the body is empty', () => {
        expect(parseServerError('', 502).message).toBe('HTTP 502');
    });
});

describe('summary', () => {
    it('parses the counters ClickHouse reports', () => {
        expect(
            parseSummary('{"read_rows":"100","read_bytes":"4096","result_rows":"10","written_rows":"0"}')
        ).toMatchObject({ readRows: 100, readBytes: 4096, resultRows: 10 });
    });

    it('returns nothing for a missing or malformed header', () => {
        expect(parseSummary(null)).toBeUndefined();
        expect(parseSummary('not json')).toBeUndefined();
        expect(parseSummary('{}')).toBeUndefined();
    });

    it('attaches the summary to the result', async () => {
        stubFetch(NAMES_TYPES_ROWS, { headers: { 'X-ClickHouse-Summary': '{"read_rows":"2"}' } });
        const result = await new ClickHouseClient(CONNECTION).query('SELECT 1');
        expect(result.summary?.readRows).toBe(2);
    });
});

describe('kill', () => {
    it('targets the query by id', async () => {
        stubFetch('');
        await new ClickHouseClient(CONNECTION).kill('abc-123');
        expect(String(calls[0].init.body)).toBe("KILL QUERY WHERE query_id = 'abc-123' SYNC");
    });

    it('escapes a quote in the id', async () => {
        stubFetch('');
        await new ClickHouseClient(CONNECTION).kill("a'b");
        expect(String(calls[0].init.body)).toContain("'a''b'");
    });
});

describe('newQueryId', () => {
    it('produces distinct v4 UUIDs', () => {
        const ids = new Set(Array.from({ length: 50 }, () => newQueryId()));
        expect(ids.size).toBe(50);
        for (const id of ids) {
            expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        }
    });
});

describe('numeric precision', () => {
    it('asks ClickHouse to quote 64-bit integers and decimals', async () => {
        stubFetch(NAMES_TYPES_ROWS);
        await new ClickHouseClient(CONNECTION).query('SELECT 1');
        // Without this, JSON.parse silently rounds a UInt64 id past 2^53.
        expect(query().get('output_format_json_quote_64bit_integers')).toBe('1');
        expect(query().get('output_format_json_quote_decimals')).toBe('1');
    });

    it('keeps a large UInt64 exact', async () => {
        stubFetch('["big"]\n["UInt64"]\n["18446744073709551615"]\n');
        const result = await new ClickHouseClient(CONNECTION).query('SELECT 1');
        expect(result.rows[0][0]).toBe('18446744073709551615');
    });

    it('lets a profile setting override the default', async () => {
        stubFetch(NAMES_TYPES_ROWS);
        await new ClickHouseClient({
            ...CONNECTION,
            settings: { output_format_json_quote_64bit_integers: 0 },
        }).query('SELECT 1');
        expect(query().get('output_format_json_quote_64bit_integers')).toBe('0');
    });
});

describe('transport failures', () => {
    /** Build the error the client would report for a given fetch rejection. */
    async function failureFor(thrown: unknown): Promise<Error> {
        (globalThis as unknown as { fetch: unknown }).fetch = jest.fn(async () => {
            throw thrown;
        });
        try {
            await new ClickHouseClient(CONNECTION).query('SELECT 1');
            throw new Error('expected a failure');
        } catch (error) {
            return error as Error;
        }
    }

    function withCause(code: string): Error {
        // This is the shape undici produces: a bare message with the real
        // reason buried in `cause`.
        const error = new TypeError('fetch failed');
        (error as unknown as { cause: unknown }).cause = Object.assign(new Error('inner'), { code });
        return error;
    }

    it('never reports the bare "fetch failed"', async () => {
        const error = await failureFor(withCause('ECONNREFUSED'));
        expect(error.message).not.toBe('fetch failed');
    });

    it('explains a refused connection, and names the address', async () => {
        const error = await failureFor(withCause('ECONNREFUSED'));
        expect(error.message).toContain('Nothing is listening');
        expect(error.message).toContain('http://ch.example:8123');
    });

    it('does not leak credentials into the message', async () => {
        const error = await failureFor(withCause('ECONNREFUSED'));
        expect(error.message).not.toContain('secret');
    });

    it('explains an unresolvable host', async () => {
        expect((await failureFor(withCause('ENOTFOUND'))).message).toContain('could not be resolved');
    });

    it('suggests https when the connection is reset', async () => {
        expect((await failureFor(withCause('ECONNRESET'))).message).toContain('https');
    });

    it('explains a timeout', async () => {
        expect((await failureFor(withCause('UND_ERR_CONNECT_TIMEOUT'))).message).toContain('Timed out');
    });

    it('explains a certificate that cannot be verified', async () => {
        expect((await failureFor(withCause('SELF_SIGNED_CERT_IN_CHAIN'))).message).toContain('certificate');
    });

    it('falls back to the cause when the code is unfamiliar', async () => {
        const error = new TypeError('fetch failed');
        (error as unknown as { cause: unknown }).cause = new Error('something specific went wrong');
        expect((await failureFor(error)).message).toContain('something specific went wrong');
    });

    it('falls back to the error itself when there is no cause', async () => {
        expect((await failureFor(new TypeError('fetch failed'))).message).toContain('fetch failed');
        expect((await failureFor(new TypeError('fetch failed'))).message).toContain('Could not reach');
    });
});

describe('transport failures from Node http', () => {
    /** Node's http module puts the code on the error, with no `cause`. */
    it('explains a refused connection reported the Node way', async () => {
        (globalThis as unknown as { fetch: unknown }).fetch = jest.fn(async () => {
            throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' });
        });
        await expect(new ClickHouseClient(CONNECTION).query('SELECT 1')).rejects.toThrow(/Nothing is listening/);
    });

    it('distinguishes a server that never answers from one we cannot reach', async () => {
        (globalThis as unknown as { fetch: unknown }).fetch = jest.fn(async () => {
            throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
        });
        // The request was accepted, so blaming the connection would mislead.
        await expect(new ClickHouseClient(CONNECTION).query('SELECT 1')).rejects.toThrow(/never answered it/);
    });

    it('still calls a genuine connect timeout what it is', async () => {
        (globalThis as unknown as { fetch: unknown }).fetch = jest.fn(async () => {
            throw Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' });
        });
        await expect(new ClickHouseClient(CONNECTION).query('SELECT 1')).rejects.toThrow(/Timed out connecting/);
    });
});

describe('truncated responses', () => {
    it('does not pass a cut-short response off as an empty result', async () => {
        // A legitimately empty result still carries its names and types lines,
        // so nothing at all means the connection died.
        stubFetch('');
        await expect(new ClickHouseClient(CONNECTION).query('SELECT 1')).rejects.toThrow(
            /closed the connection before sending any results/
        );
    });

    it('still accepts a genuinely empty result', async () => {
        stubFetch('["id"]\n["UInt64"]\n');
        const result = await new ClickHouseClient(CONNECTION).query('SELECT id FROM t WHERE 0');
        expect(result.rows).toEqual([]);
        expect(result.columns).toHaveLength(1);
    });
});

describe('authentication', () => {
    it('sends the ClickHouse user and key headers by default', async () => {
        stubFetch(NAMES_TYPES_ROWS);
        await new ClickHouseClient(CONNECTION).query('SELECT 1');
        const headers = calls[0].init.headers as Record<string, string>;
        expect(headers['X-ClickHouse-User']).toBe('reader');
        expect(headers['X-ClickHouse-Key']).toBe('secret');
        expect(headers).not.toHaveProperty('Authorization');
    });

    it('sends a bearer token when the profile uses one', async () => {
        stubFetch(NAMES_TYPES_ROWS);
        await new ClickHouseClient({ ...CONNECTION, auth: 'token', password: 'tok-123' }).query('SELECT 1');
        const headers = calls[0].init.headers as Record<string, string>;
        expect(headers['Authorization']).toBe('Bearer tok-123');
        // A token replaces the user headers rather than accompanying them.
        expect(headers).not.toHaveProperty('X-ClickHouse-User');
        expect(headers).not.toHaveProperty('X-ClickHouse-Key');
    });

    it('keeps the token out of the URL', async () => {
        stubFetch(NAMES_TYPES_ROWS);
        await new ClickHouseClient({ ...CONNECTION, auth: 'token', password: 'tok-123' }).query('SELECT 1');
        expect(calls[0].url).not.toContain('tok-123');
    });

    it('sends no credential header when there is no secret', async () => {
        stubFetch(NAMES_TYPES_ROWS);
        await new ClickHouseClient({ ...CONNECTION, auth: 'token', password: undefined }).query('SELECT 1');
        expect(calls[0].init.headers as Record<string, string>).not.toHaveProperty('Authorization');
    });
});

describe('preparing a statement for the wire', () => {
    /**
     * The request always ends with `FORMAT JSONCompactEachRowWithNamesAndTypes`
     * because the grid can only read one format. Found by running a notebook
     * against a real server: a cell ending in `;` made ClickHouse read the
     * appended FORMAT as a second statement and refuse the whole thing with
     * "Multi-statements are not allowed", pointing at a line the user never
     * wrote. Notebook cells always carry a terminator, and so does anyone who
     * selects a whole statement and runs it.
     */
    it('drops a trailing semicolon', () => {
        expect(prepareStatement('SELECT 1;').sql).toBe('SELECT 1');
        expect(prepareStatement('SELECT 1;\n').sql).toBe('SELECT 1');
        expect(prepareStatement('SELECT 1;;').sql).toBe('SELECT 1');
    });

    it('drops one that a comment follows', () => {
        expect(prepareStatement('SELECT 1; -- done').sql).toBe('SELECT 1');
    });

    it('keeps a comment that comes before it', () => {
        // Everything before the dropped token survives exactly as written.
        expect(prepareStatement('SELECT 1\n-- a note\n;').sql).toBe('SELECT 1\n-- a note');
    });

    it('leaves a semicolon inside a string alone', () => {
        // Which is why this tokenises rather than matching text.
        expect(prepareStatement("SELECT ';' AS x").sql).toBe("SELECT ';' AS x");
        expect(prepareStatement("SELECT ';'").sql).toBe("SELECT ';'");
        expect(prepareStatement("SELECT ';';").sql).toBe("SELECT ';'");
    });

    it('leaves a statement that needs nothing done to it untouched', () => {
        const sql = 'SELECT a, b FROM t WHERE a > 1';
        expect(prepareStatement(sql)).toEqual({ sql });
    });

    it('replaces a FORMAT of the user\'s own, and says which', () => {
        // It cannot be honoured - the grid has no way to render CSV - and
        // leaving it in place produces a syntax error rather than an explanation.
        expect(prepareStatement('SELECT 1 FORMAT CSV')).toEqual({ sql: 'SELECT 1', replacedFormat: 'CSV' });
        expect(prepareStatement('SELECT 1 FORMAT CSV;')).toEqual({ sql: 'SELECT 1', replacedFormat: 'CSV' });
        expect(prepareStatement('SELECT 1 format json')).toMatchObject({ replacedFormat: 'json' });
    });

    it('leaves the word FORMAT alone when it is not a clause', () => {
        expect(prepareStatement('SELECT 1 -- FORMAT CSV').replacedFormat).toBeUndefined();
        expect(prepareStatement("SELECT 'FORMAT CSV'").replacedFormat).toBeUndefined();
        expect(prepareStatement('SELECT formatDateTime(now(), \'%F\')').replacedFormat).toBeUndefined();
    });

    it('copes with nothing at all', () => {
        expect(prepareStatement('').sql).toBe('');
        expect(prepareStatement(';').sql).toBe('');
        expect(prepareStatement('   ').sql).toBe('   ');
    });

    it('sends the prepared statement, not the original', async () => {
        stubFetch(NAMES_TYPES_ROWS);
        await new ClickHouseClient(CONNECTION).query('SELECT 1;');
        const body = (globalThis.fetch as jest.Mock).mock.calls[0][1].body as string;
        expect(body).toBe('SELECT 1\nFORMAT JSONCompactEachRowWithNamesAndTypes');
        expect(body).not.toContain(';');
    });

    it('traces a replaced FORMAT rather than doing it silently', async () => {
        stubFetch(NAMES_TYPES_ROWS);
        const notes: string[] = [];
        await new ClickHouseClient(CONNECTION).query('SELECT 1 FORMAT CSV', { onTrace: note => notes.push(note) });
        expect(notes.join('\n')).toContain('ignoring FORMAT CSV');
    });
});
