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

export const fetchSender: HttpSender = {
    name: 'fetch',
    async send(request: SendRequest): Promise<SendResponse> {
        const response = await fetch(request.url, {
            method: request.method,
            headers: request.headers,
            body: request.body,
            signal: request.signal,
        });

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

export function createNodeSender(modules: { http: NodeHttpModule; https: NodeHttpModule }): HttpSender {
    return {
        name: 'node:http',
        send(request: SendRequest): Promise<SendResponse> {
            return new Promise<SendResponse>((resolve, reject) => {
                const secure = request.url.startsWith('https:');
                const module = secure ? modules.https : modules.http;

                const clientRequest = module.request(
                    request.url,
                    {
                        method: request.method,
                        headers: {
                            ...request.headers,
                            // Node does not add this for a string body.
                            'Content-Length': String(Buffer.byteLength(request.body)),
                        },
                        signal: request.signal,
                    },
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

                        resolve({
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

                clientRequest.on('error', error => reject(error as Error));
                clientRequest.write(request.body);
                clientRequest.end();
            });
        },
    };
}

let cached: HttpSender | undefined;

/** Node's http where available, `fetch` otherwise. */
export function createSender(): HttpSender {
    const modules = loadNodeHttp();
    return modules ? createNodeSender(modules) : fetchSender;
}

export function defaultSender(): HttpSender {
    if (!cached) cached = createSender();
    return cached;
}

/** Override the sender. Used by tests, which drive a stubbed `fetch`. */
export function useSender(sender: HttpSender | undefined): void {
    cached = sender;
}
