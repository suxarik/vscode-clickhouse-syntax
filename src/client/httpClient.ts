/**
 * ClickHouse HTTP client.
 *
 * HTTP rather than the native protocol on purpose: no binary codec to maintain,
 * and it is the only transport available in the web extension host. Built on
 * `fetch`, which both hosts provide.
 *
 * Results stream as `JSONCompactEachRowWithNamesAndTypes` — one JSON array per
 * line — so the first rows reach the grid immediately and a long query can be
 * cancelled mid-read.
 */
import { ClickHouseError, ColumnMeta, QueryResult, QuerySummary, ResolvedConnection } from './types';
import { defaultSender, HttpSender, SendResponse } from './transport';

export interface QueryOptions {
    /** Supplied so the query can be cancelled with KILL QUERY. */
    queryId?: string;
    signal?: AbortSignal;
    /**
     * Send `readonly=2`, which lets ClickHouse itself reject writes. The client
     * also refuses them before sending; neither check is trusted alone.
     */
    readOnly?: boolean;
    /** Stop reading after this many rows. 0 reads everything. */
    maxRows?: number;
    maxExecutionTime?: number;
    /** Called once, as soon as the column names and types are known. */
    onColumns?: (columns: ColumnMeta[]) => void;
    /** Called as rows arrive, for progressive rendering. */
    onRows?: (rows: unknown[][], total: number) => void;
    /** Overrides the profile's database for this query. */
    database?: string;
    /** Client-side deadline. Defaults to the server limit plus a margin. */
    timeoutMs?: number;
    /** Progress notes for the diagnostics log. */
    onTrace?: (note: string) => void;
}

const STREAM_FORMAT = 'JSONCompactEachRowWithNamesAndTypes';

/** RFC 4122 v4, using the crypto both hosts provide. */
export function newQueryId(): string {
    if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
    // Deterministic fallback for environments without WebCrypto.
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** `Code: 60. DB::Exception: Table x does not exist.` */
export function parseServerError(body: string, httpStatus: number): ClickHouseError {
    const match = /^Code:\s*(\d+)\.\s*(?:DB::(?:Exception|ErrnoException):\s*)?([\s\S]*)$/m.exec(body.trim());
    if (!match) {
        return new ClickHouseError(body.trim() || `HTTP ${httpStatus}`, undefined, httpStatus);
    }
    const code = Number.parseInt(match[1], 10);
    // Drop the stack-trace tail ClickHouse appends after the message.
    const message = match[2].split(/\n\s*(?:Stack trace|\(version )/)[0].trim();
    return new ClickHouseError(message, code, httpStatus);
}

/**
 * Turn a transport failure into something a person can act on.
 *
 * `fetch` reports every network problem as the bare string "fetch failed" and
 * hides the reason in `cause`, which is useless to someone staring at a
 * notification. This unwraps it and says which address failed.
 */
export function describeTransportFailure(error: unknown, url: string): ClickHouseError {
    const target = url.split('?')[0];

    if (error instanceof Error && (error as { code?: string }).code === 'ABORT_ERR') {
        return new ClickHouseError('The query was cancelled.');
    }

    if (error instanceof Error && error.name === 'AbortError') {
        const reason = (error as { cause?: unknown }).cause;
        const timedOut = reason instanceof Error && reason.message === 'timeout';
        return new ClickHouseError(
            timedOut ? `${target} did not respond in time.` : 'The query was cancelled.'
        );
    }

    // Node's http puts the code on the error itself; undici buries it in
    // `cause`. Look in both, or the mapping below is dead on one of the two
    // transports.
    const cause = (error as { cause?: unknown }).cause;
    const codeOf = (value: unknown): string | undefined =>
        value && typeof value === 'object' && 'code' in value
            ? String((value as { code: unknown }).code)
            : undefined;
    const code = codeOf(error) ?? codeOf(cause);
    const causeMessage =
        cause instanceof Error ? cause.message : cause !== undefined ? String(cause) : undefined;

    switch (code) {
        case 'ECONNREFUSED':
            return new ClickHouseError(
                `Nothing is listening at ${target}. Check the host and port, and that the server is running.`
            );
        case 'ENOTFOUND':
        case 'EAI_AGAIN':
            return new ClickHouseError(`The host in ${target} could not be resolved.`);
        case 'ECONNRESET':
            return new ClickHouseError(`The connection to ${target} was reset. If the server speaks HTTPS, set "protocol": "https".`);
        case 'UND_ERR_CONNECT_TIMEOUT':
            return new ClickHouseError(`Timed out connecting to ${target}.`);
        case 'ETIMEDOUT':
            return new ClickHouseError(
                `${target} accepted the request but never answered it. ` +
                    `The server is reachable, so this is the editor's HTTP layer rather than ClickHouse.`
            );
        case 'DEPTH_ZERO_SELF_SIGNED_CERT':
        case 'SELF_SIGNED_CERT_IN_CHAIN':
        case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
            return new ClickHouseError(`The TLS certificate at ${target} could not be verified (${code}).`);
        default:
            break;
    }

    const detail = causeMessage ?? (error instanceof Error ? error.message : String(error));
    return new ClickHouseError(`Could not reach ${target} - ${detail}`);
}

/** `X-ClickHouse-Summary` is JSON with string-valued counters. */
export function parseSummary(header: string | null): QuerySummary | undefined {
    if (!header) return undefined;
    try {
        const raw = JSON.parse(header) as Record<string, string>;
        const num = (key: string) => (raw[key] === undefined ? undefined : Number(raw[key]));
        const summary: QuerySummary = {
            readRows: num('read_rows'),
            readBytes: num('read_bytes'),
            writtenRows: num('written_rows'),
            writtenBytes: num('written_bytes'),
            totalRowsToRead: num('total_rows_to_read'),
            resultRows: num('result_rows'),
            resultBytes: num('result_bytes'),
        };
        return Object.values(summary).some(value => value !== undefined && !Number.isNaN(value))
            ? summary
            : undefined;
    } catch {
        return undefined;
    }
}

export class ClickHouseClient {
    constructor(
        private readonly connection: ResolvedConnection,
        private readonly sender: HttpSender = defaultSender()
    ) {}

    /** Which transport this client is using, for diagnostics. */
    get transportName(): string {
        return this.sender.name;
    }

    /**
     * Client-side deadline. The server's own `max_execution_time` should fire
     * first; this exists so a connection that stalls before the server ever
     * sees the query cannot hang the UI forever.
     */
    private deadline(options: QueryOptions): number {
        if (options.timeoutMs !== undefined) return options.timeoutMs;
        const serverLimit = options.maxExecutionTime && options.maxExecutionTime > 0 ? options.maxExecutionTime : 60;
        return (serverLimit + 15) * 1000;
    }

    private buildUrl(options: QueryOptions): string {
        const params = new URLSearchParams();

        // JSON.parse rounds anything past 2^53, so a UInt64 event id would come
        // back wrong. Asking ClickHouse to quote 64-bit integers and decimals
        // keeps them exact; the column type tells the grid how to render them.
        params.set('output_format_json_quote_64bit_integers', '1');
        params.set('output_format_json_quote_decimals', '1');

        params.set('database', options.database ?? this.connection.database);
        if (options.queryId) params.set('query_id', options.queryId);
        if (options.readOnly) params.set('readonly', '2');
        if (options.maxRows && options.maxRows > 0) {
            // One extra row tells us whether the result was cut short.
            params.set('max_result_rows', String(options.maxRows + 1));
            params.set('result_overflow_mode', 'break');
        }
        if (options.maxExecutionTime && options.maxExecutionTime > 0) {
            params.set('max_execution_time', String(options.maxExecutionTime));
        }
        for (const [key, value] of Object.entries(this.connection.settings)) {
            params.set(key, String(value));
        }
        return `${this.connection.url}/?${params.toString()}`;
    }

    private headers(): Record<string, string> {
        const headers: Record<string, string> = {
            'Content-Type': 'text/plain; charset=utf-8',
            'X-ClickHouse-User': this.connection.user,
        };
        // Credentials go in headers, never the URL, so they stay out of logs.
        if (this.connection.password) headers['X-ClickHouse-Key'] = this.connection.password;
        return headers;
    }

    /** Run a statement and collect its rows. */
    async query(sql: string, options: QueryOptions = {}): Promise<QueryResult> {
        const queryId = options.queryId ?? newQueryId();
        const started = Date.now();

        const url = this.buildUrl({ ...options, queryId });
        const trace = options.onTrace ?? (() => undefined);

        // One deadline for the whole exchange, not just the response headers:
        // a body that stops arriving mid-stream would otherwise hang forever.
        // The flag matters because aborting is also how cancellation works, and
        // reporting a timeout as "cancelled" sends anyone debugging it the
        // wrong way entirely.
        const controller = new AbortController();
        let deadlineFired = false;
        options.signal?.addEventListener('abort', () => controller.abort(), { once: true });
        const deadline = this.deadline(options);
        const timer =
            deadline > 0
                ? setTimeout(() => {
                      deadlineFired = true;
                      controller.abort();
                  }, deadline)
                : undefined;

        try {
            let response: SendResponse;
            trace(`sending to ${url.split('?')[0]} via ${this.sender.name}`);
            try {
                response = await this.sender.send({
                    url,
                    method: 'POST',
                    headers: this.headers(),
                    body: `${sql}\nFORMAT ${STREAM_FORMAT}`,
                    signal: controller.signal,
                    onTrace: options.onTrace,
                });
            } catch (error) {
                if (deadlineFired) {
                    throw new ClickHouseError(
                        `${url.split('?')[0]} did not answer within ${Math.round(deadline / 1000)}s.`
                    );
                }
                throw describeTransportFailure(error, url);
            }
            trace(`response ${response.status}`);

            if (!response.ok) {
                throw parseServerError(await response.text(), response.status);
            }

            let read;
            try {
                read = await this.readRows(response, options);
            } catch (error) {
                if (deadlineFired) {
                    throw new ClickHouseError(
                        `${url.split('?')[0]} stopped sending the result partway through.`
                    );
                }
                throw error;
            }
            const { columns, rows, truncated } = read;
            trace(`read ${rows.length} row(s), ${columns.length} column(s)`);
            return {
                queryId,
                columns,
                rows,
                truncated,
                elapsedMs: Date.now() - started,
                summary: parseSummary(response.header('X-ClickHouse-Summary')),
            };
        } finally {
            if (timer !== undefined) clearTimeout(timer);
        }
    }

    /**
     * Run a statement whose result we do not need — DDL, INSERT, KILL.
     * Returns the server's response body, which is usually empty.
     */
    async execute(sql: string, options: QueryOptions = {}): Promise<string> {
        const url = this.buildUrl(options);
        let response: SendResponse;
        try {
            response = await this.sender.send({
                url,
                method: 'POST',
                headers: this.headers(),
                body: sql,
                signal: options.signal,
                timeoutMs: this.deadline(options),
            });
        } catch (error) {
            throw describeTransportFailure(error, url);
        }
        const body = await response.text();
        if (!response.ok) throw parseServerError(body, response.status);
        return body;
    }

    /** Ask the server to stop a running query. Best effort. */
    async kill(queryId: string): Promise<void> {
        const escaped = queryId.replace(/'/g, "''");
        await this.execute(`KILL QUERY WHERE query_id = '${escaped}' SYNC`, { readOnly: false });
    }

    /** Server version, used by `Test Connection` and version gating. */
    async version(options: QueryOptions = {}): Promise<string> {
        const result = await this.query('SELECT version()', { ...options, readOnly: true });
        return String(result.rows[0]?.[0] ?? '');
    }

    /**
     * Read the NDJSON stream: first line names, second line types, then rows.
     */
    private async readRows(
        response: SendResponse,
        options: QueryOptions
    ): Promise<{ columns: ColumnMeta[]; rows: unknown[][]; truncated: boolean }> {
        const limit = options.maxRows && options.maxRows > 0 ? options.maxRows : Infinity;
        const rows: unknown[][] = [];
        let names: string[] = [];
        let types: string[] = [];
        let lineNumber = 0;
        let truncated = false;

        const handleLine = (line: string): boolean => {
            if (!line) return true;
            let parsed: unknown;
            try {
                parsed = JSON.parse(line);
            } catch {
                // A malformed tail can only mean a truncated stream.
                return true;
            }
            if (lineNumber === 0) names = parsed as string[];
            else if (lineNumber === 1) {
                types = parsed as string[];
                options.onColumns?.(
                    names.map((name, index) => ({ name, type: types[index] ?? 'Unknown' }))
                );
            } else if (rows.length < limit) rows.push(parsed as unknown[]);
            else {
                truncated = true;
                return false;
            }
            lineNumber++;
            return true;
        };

        const trace = options.onTrace ?? (() => undefined);
        const stream = response.chunks();
        if (!stream) {
            trace('body is not streamable; reading it whole');
            for (const line of (await response.text()).split('\n')) {
                if (!handleLine(line.trim())) break;
            }
        } else {
            const decoder = new TextDecoder();
            let buffer = '';
            let batchStart = 0;
            let chunkCount = 0;

            for await (const chunk of stream) {
                if (chunkCount === 0) trace('first chunk received');
                chunkCount++;
                buffer += decoder.decode(chunk, { stream: true });

                let newline: number;
                let stop = false;
                while ((newline = buffer.indexOf('\n')) >= 0) {
                    const line = buffer.slice(0, newline).trim();
                    buffer = buffer.slice(newline + 1);
                    if (!handleLine(line)) {
                        stop = true;
                        break;
                    }
                }

                if (options.onRows && rows.length > batchStart) {
                    options.onRows(rows.slice(batchStart), rows.length);
                    batchStart = rows.length;
                }
                if (stop) break;
            }
            trace(`stream ended after ${chunkCount} chunk(s)`);
            if (!truncated && buffer.trim()) handleLine(buffer.trim());
        }

        // ClickHouse always sends the names and types lines, even for an empty
        // result. Getting neither means the response was cut short, which must
        // not be reported as "0 rows".
        if (lineNumber === 0) {
            throw new ClickHouseError('The server closed the connection before sending any results.');
        }

        const columns: ColumnMeta[] = names.map((name, index) => ({
            name,
            type: types[index] ?? 'Unknown',
        }));
        return { columns, rows, truncated };
    }
}
