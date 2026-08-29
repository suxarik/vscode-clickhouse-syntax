/**
 * How requests actually leave the process.
 *
 * The desktop extension host wraps the global `fetch` for proxy and certificate
 * support, and that wrapper has proved unreliable for plain local HTTP -
 * intermittent connect timeouts against a server that answers instantly from
 * plain Node. Rather than depend on however the host has patched a global this
 * month, the desktop build talks to Node's own http module directly and keeps
 * `fetch` for the web build, which has no alternative.
 */

export interface SendRequest {
    url: string;
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
    /**
     * Give up if the server has not responded within this many milliseconds.
     * Without it a stalled connection hangs forever and the caller has nothing
     * to report.
     */
    timeoutMs?: number;
    /** Progress notes, so a failure names the transport that produced it. */
    onTrace?: (note: string) => void;
}

export interface SendResponse {
    status: number;
    ok: boolean;
    header(name: string): string | null;
    text(): Promise<string>;
    /** Chunks as they arrive, or undefined when the body cannot be streamed. */
    chunks(): AsyncIterable<Uint8Array> | undefined;
}

export interface HttpSender {
    readonly name: string;
    send(request: SendRequest): Promise<SendResponse>;
}

// ── fetch ────────────────────────────────────────────────────────────────────

/** An abort signal that also fires on a timeout, if one was asked for. */
function withTimeout(request: SendRequest): { signal: AbortSignal | undefined; done(): void } {
    if (!request.timeoutMs || request.timeoutMs <= 0) return { signal: request.signal, done: () => undefined };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), request.timeoutMs);
    request.signal?.addEventListener('abort', () => controller.abort(), { once: true });
    return { signal: controller.signal, done: () => clearTimeout(timer) };
}

export const fetchSender: HttpSender = {
    name: 'fetch',
    async send(request: SendRequest): Promise<SendResponse> {
        const timeout = withTimeout(request);
        let response: Response;
        try {
            response = await fetch(request.url, {
                method: request.method,
                headers: request.headers,
                body: request.body,
                signal: timeout.signal,
            });
        } finally {
            timeout.done();
        }

        return {
            status: response.status,
            ok: response.ok,
            header: name => response.headers.get(name),
            text: () => response.text(),
            chunks: () => {
                const body = response.body;
                if (!body) return undefined;
                return {
                    async *[Symbol.asyncIterator]() {
                        const reader = body.getReader();
                        try {
                            for (;;) {
                                const { done, value } = await reader.read();
                                if (done) return;
                                if (value) yield value;
                            }
                        } finally {
                            // Releasing is best effort: never lose rows to it.
                            try {
                                reader.releaseLock?.();
                            } catch {
                                // The stream is already done with.
                            }
                        }
                    },
                };
            },
        };
    },
};

// ── node:http ────────────────────────────────────────────────────────────────

interface NodeRequestOptions {
    method: string;
    headers: Record<string, string>;
    signal?: AbortSignal;
    /**
     * Try IPv4 and IPv6 concurrently and keep whichever connects first.
     *
     * `localhost` resolves to `::1` before `127.0.0.1`, and a server reachable
     * on IPv4 can be silently unreachable on IPv6 - Docker on macOS advertises
     * both and stalls on one. Without this, Node commits to the first address
     * and hangs; curl appears to work because it already races them.
     */
    autoSelectFamily?: boolean;
    autoSelectFamilyAttemptTimeout?: number;
}

interface NodeIncoming {
    statusCode?: number;
    headers: Record<string, string | string[] | undefined>;
    setEncoding(encoding: string): void;
    on(event: string, listener: (...args: unknown[]) => void): void;
    destroy(): void;
    [Symbol.asyncIterator](): AsyncIterableIterator<Buffer>;
}

interface NodeClientRequest {
    on(event: string, listener: (...args: unknown[]) => void): void;
    write(chunk: string): void;
    end(): void;
    destroy(error?: Error): void;
}

interface NodeHttpModule {
    request(url: string, options: NodeRequestOptions, callback: (response: NodeIncoming) => void): NodeClientRequest;
    /**
     * The class behind `request`. The desktop host wraps the `request` function
     * for proxy support; constructing the class directly is not wrapped.
     */
    ClientRequest?: new (
        url: string,
        options: NodeRequestOptions,
        callback: (response: NodeIncoming) => void
    ) => NodeClientRequest;
}

export interface NodeSocket {
    remoteAddress?: string;
    setTimeout(ms: number, callback: () => void): void;
    on(event: string, listener: (...args: unknown[]) => void): void;
    destroy(): void;
}

export interface NodeNetModule {
    connect(options: { host: string; port: number }, callback: () => void): NodeSocket;
}

/** The Node modules the desktop build uses, or undefined on the web. */
export function loadNodeModules():
    | { http: NodeHttpModule; https: NodeHttpModule; net?: NodeNetModule }
    | undefined {
    const modules = loadNodeHttp();
    if (!modules) return undefined;
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return { ...modules, net: require('node:net') as NodeNetModule };
    } catch {
        return modules;
    }
}

/** Load Node's http modules, or report that we are not on Node. */
function loadNodeHttp(): { http: NodeHttpModule; https: NodeHttpModule } | undefined {
    try {
        // The web build has no Node built-ins; the require throws and we fall
        // back to fetch. Marked external so bundling never tries to inline it.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const http = require('node:http') as NodeHttpModule;
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const https = require('node:https') as NodeHttpModule;
        return http && https ? { http, https } : undefined;
    } catch {
        return undefined;
    }
}

function firstHeader(value: string | string[] | undefined): string | null {
    if (value === undefined) return null;
    return Array.isArray(value) ? (value[0] ?? null) : value;
}

export interface NodeSenderOptions {
    /**
     * Go through `http.request` rather than constructing a ClientRequest.
     * Only useful for proving which of the two the host has broken.
     */
    usePatchedRequest?: boolean;
}

export function createNodeSender(
    modules: { http: NodeHttpModule; https: NodeHttpModule },
    senderOptions: NodeSenderOptions = {}
): HttpSender {
    const direct = !senderOptions.usePatchedRequest && typeof modules.http.ClientRequest === 'function';

    return {
        name: direct ? 'node:http (direct)' : 'node:http',
        send(request: SendRequest): Promise<SendResponse> {
            return new Promise<SendResponse>((resolve, reject) => {
                const secure = request.url.startsWith('https:');
                const module = secure ? modules.https : modules.http;

                let settled = false;
                const finish = <T>(action: (value: T) => void) => (value: T) => {
                    if (settled) return;
                    settled = true;
                    if (timer !== undefined) clearTimeout(timer);
                    action(value);
                };
                const fail = finish(reject);

                // A stalled connection must not hang the caller forever.
                const timer =
                    request.timeoutMs && request.timeoutMs > 0
                        ? setTimeout(() => {
                              clientRequest.destroy(
                                  Object.assign(new Error('The server did not respond in time.'), {
                                      code: 'ETIMEDOUT',
                                  })
                              );
                          }, request.timeoutMs)
                        : undefined;

                // The signal is deliberately not handed to http.request. The
                // desktop host patches that function for proxy support, and an
                // option it does not forward would leave the request hanging
                // with no response and no error. Destroying the request
                // ourselves cancels it without depending on the option at all.
                const requestOptions: NodeRequestOptions = {
                    method: request.method,
                    headers: {
                        ...request.headers,
                        // Node does not add this for a string body.
                        'Content-Length': String(Buffer.byteLength(request.body)),
                    },
                    autoSelectFamily: true,
                    autoSelectFamilyAttemptTimeout: 500,
                };

                const start = (callback: (response: NodeIncoming) => void): NodeClientRequest => {
                    const ClientRequest = module.ClientRequest;
                    if (direct && ClientRequest) return new ClientRequest(request.url, requestOptions, callback);
                    return module.request(request.url, requestOptions, callback);
                };

                const clientRequest = start(
                    incoming => {
                        const status = incoming.statusCode ?? 0;
                        let consumed = false;

                        const collect = () =>
                            new Promise<string>((resolveText, rejectText) => {
                                let text = '';
                                incoming.setEncoding('utf8');
                                incoming.on('data', chunk => {
                                    text += String(chunk);
                                });
                                incoming.on('end', () => resolveText(text));
                                incoming.on('error', error => rejectText(error as Error));
                            });

                        finish(resolve)({
                            status,
                            ok: status >= 200 && status < 300,
                            header: name => firstHeader(incoming.headers[name.toLowerCase()]),
                            text: () => {
                                consumed = true;
                                return collect();
                            },
                            chunks: () => {
                                if (consumed) return undefined;
                                consumed = true;
                                return incoming;
                            },
                        });
                    }
                );

                clientRequest.on('error', error => fail(error as Error));

                if (request.signal) {
                    const abort = () =>
                        clientRequest.destroy(
                            Object.assign(new Error('The query was cancelled.'), { code: 'ABORT_ERR' })
                        );
                    if (request.signal.aborted) abort();
                    else request.signal.addEventListener('abort', abort, { once: true });
                }

                clientRequest.write(request.body);
                clientRequest.end();
            });
        },
    };
}

/**
 * Try each transport in turn until one answers, then stick with it.
 *
 * The desktop host wraps both `fetch` and `http.request`, and which of them
 * works has proved to depend on the host build. Rather than guess, this tries
 * them in order of preference and remembers the first that produces a response.
 * A transport only throws when no response was produced at all, so falling
 * through is always safe: nothing has been read yet.
 */
export function createFallbackSender(candidates: HttpSender[]): HttpSender {
    if (candidates.length === 1) return candidates[0];
    let chosen: HttpSender | undefined;

    return {
        get name(): string {
            return chosen ? chosen.name : candidates.map(candidate => candidate.name).join(' → ');
        },
        async send(request: SendRequest): Promise<SendResponse> {
            if (chosen) return chosen.send(request);

            const failures: string[] = [];
            // Share the budget, so a hanging candidate cannot use it all up.
            const perCandidate = request.timeoutMs
                ? Math.max(2000, Math.floor(request.timeoutMs / candidates.length))
                : undefined;

            for (const candidate of candidates) {
                try {
                    const response = await candidate.send({ ...request, timeoutMs: perCandidate });
                    chosen = candidate;
                    request.onTrace?.(`transport ${candidate.name} answered`);
                    return response;
                } catch (error) {
                    const reason = error instanceof Error ? error.message : String(error);
                    failures.push(`${candidate.name}: ${reason}`);
                    request.onTrace?.(`transport ${candidate.name} failed - ${reason}`);
                }
            }
            throw new Error(`No usable HTTP transport. ${failures.join('; ')}`);
        },
    };
}

/** Node's http where available, `fetch` otherwise, with fallback between them. */
export function createSender(): HttpSender {
    const modules = loadNodeHttp();
    if (!modules) return fetchSender;
    return createFallbackSender([
        createNodeSender(modules),
        createNodeSender(modules, { usePatchedRequest: true }),
        fetchSender,
    ]);
}

let cached: HttpSender | undefined;

export function defaultSender(): HttpSender {
    if (!cached) cached = createSender();
    return cached;
}

/** Override the sender. Used by tests, which drive a stubbed `fetch`. */
export function useSender(sender: HttpSender | undefined): void {
    cached = sender;
}
