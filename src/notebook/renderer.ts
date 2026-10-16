/**
 * The notebook output renderer.
 *
 * This runs in its own iframe with no `vscode` API at all, which is why the
 * grid was built behind a transport seam: `GridView` is imported here
 * unmodified and fed the result it would have received over a webview channel.
 *
 * Anything that needs the extension host - the clipboard, saving a file - goes
 * back over the renderer messaging channel, because this side cannot do either.
 */
import { GridView } from '../results/view/gridView';
import { GRID_STYLE } from '../results/view/style';
import { Transport } from '../results/view/transport';
import { HostMessage, SerializationFormat, ViewMessage } from '../results/protocol';
import { serialize } from '../results/serialize';
import { CellResult } from './controller';
import { PlanView } from '../explain/view/planView';
import { PLAN_STYLE } from '../explain/view/planStyle';
import { PLAN_MIME, PlanHostMessage, PlanPayload, PlanTransport, PlanViewMessage } from '../explain/protocol';

/** The slice of VS Code's renderer API this file uses. */
interface RendererContext {
    postMessage?(message: unknown): void;
    onDidReceiveMessage?(handler: (message: unknown) => void): { dispose(): void };
}

interface OutputItem {
    id: string;
    mime: string;
    /** A cell output is a result or a plan, never both. */
    json(): CellResult | PlanPayload;
}

/** Styles belong to the iframe, so they are injected once rather than per cell. */
function ensureStyles(): void {
    const id = 'ch-grid-style';
    if (document.getElementById(id)) return;
    const style = document.createElement('style');
    style.id = id;
    style.textContent = `${GRID_STYLE}
/* A notebook output is a band in a scrolling document, not a full pane. */
.ch-results { height: 420px; max-height: 70vh; position: relative; }
.ch-cancel { display: none; }
`;
    document.head.appendChild(style);
}

/** The plan view needs its own styles, and its own height inside a cell. */
function ensurePlanStyles(): void {
    const id = 'ch-plan-style';
    if (document.getElementById(id)) return;
    const style = document.createElement('style');
    style.id = id;
    style.textContent = `${PLAN_STYLE}
/* A runbook output is a band in a scrolling document, not a full pane. */
.ch-plan { height: 460px; max-height: 72vh; }
`;
    document.head.appendChild(style);
}

/** Draw a stored plan in a runbook cell, using the same view the panel uses. */
function mountPlan(payload: PlanPayload, root: HTMLElement, context: RendererContext): void {
    ensurePlanStyles();

    let deliver: ((message: PlanHostMessage) => void) | undefined;
    const transport: PlanTransport = {
        post(message: PlanViewMessage) {
            if (message.type === 'ready') {
                deliver?.({ type: 'plan', payload });
                return;
            }
            // Saving a file belongs to the extension host; the image is made
            // here, so only the finished image crosses.
            context.postMessage?.({
                type: 'exportImage',
                format: message.format,
                data: message.data,
                suggestedName: 'clickhouse-plan',
            });
        },
        onMessage(handler: (message: PlanHostMessage) => void) {
            deliver = handler;
        },
    };

    new PlanView(root, transport);
}

/**
 * Replay a finished result to the grid.
 *
 * The grid asks for nothing and waits for messages, so a stored result is
 * delivered as the messages a live query would have produced. It is already
 * complete, so `begin` through `end` arrive in one go - the grid cannot tell,
 * and does not need to.
 */
function replay(result: CellResult): HostMessage[] {
    const messages: HostMessage[] = [{ type: 'begin', header: result.header }];
    if (result.columns.length > 0) messages.push({ type: 'columns', columns: result.columns });
    if (result.rows.length > 0) messages.push({ type: 'rows', rows: result.rows, total: result.rows.length });
    if (result.error) messages.push({ type: 'error', message: result.error });
    else messages.push({ type: 'end', statistics: result.statistics ?? {}, truncated: result.truncated });
    return messages;
}

/** The result as text, in the format that was asked for. */
function textFor(result: CellResult, format: SerializationFormat): string {
    return serialize({ columns: result.columns, rows: result.rows, includeHeader: true }, format);
}

/** A filename that says which query this came from. */
function nameFor(result: CellResult): string {
    const slug = result.header.query
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 40)
        .replace(/[^\w]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase();
    return slug || 'clickhouse-result';
}

export function activate(context: RendererContext) {
    ensureStyles();

    return {
        renderOutputItem(item: OutputItem, element: HTMLElement) {
            element.replaceChildren();
            const root = document.createElement('div');
            element.appendChild(root);

            if (item.mime === PLAN_MIME) {
                mountPlan(item.json() as PlanPayload, root, context);
                return;
            }

            const result = item.json() as CellResult;
            let deliver: ((message: HostMessage) => void) | undefined;

            const transport: Transport = {
                post(message: ViewMessage) {
                    if (message.type === 'ready') {
                        for (const replayed of replay(result)) deliver?.(replayed);
                        return;
                    }
                    // A cancel from a finished result has nothing to cancel.
                    if (message.type === 'cancel') return;
                    // The clipboard and the filesystem belong to the extension
                    // host, but the rows are here - so the text is made here and
                    // only the finished text crosses, rather than the host
                    // having to find this output again to re-serialise it.
                    context.postMessage?.({
                        type: message.type,
                        format: message.format,
                        text: textFor(result, message.format),
                        suggestedName: nameFor(result),
                    });
                },
                onMessage(handler: (message: HostMessage) => void) {
                    deliver = handler;
                },
            };

            new GridView(root, transport);
        },

        disposeOutputItem(_id?: string) {
            // The grid holds no timers or listeners outside its own element, so
            // dropping the element is enough.
        },
    };
}
