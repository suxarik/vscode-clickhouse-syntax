/**
 * Completing a model name inside `{{ ref('…') }}`.
 *
 * This is the one place the manifest pays for itself directly. Typing a model
 * name from memory is where dbt refs go wrong, and the manifest already holds
 * every name the project defines.
 *
 * The cursor here is inside a string literal, where completion is normally
 * suppressed - so this is checked first, before that rule applies.
 */

export type DbtCompletionKind = 'model' | 'source' | 'sourceTable';

export interface DbtCompletionRequest {
    kind: DbtCompletionKind;
    /** What has been typed inside the quotes so far. */
    prefix: string;
    /** For `source('raw', '|')`, the source already named. */
    sourceName?: string;
    /** Range of the text to replace, as offsets into the document. */
    start: number;
    end: number;
}

/** The `{{ … }}` tag containing this offset, if any. */
function enclosingTag(text: string, offset: number): { start: number; end: number } | undefined {
    const open = text.lastIndexOf('{{', offset);
    if (open === -1) return undefined;
    const close = text.indexOf('}}', open);
    // An unclosed tag is the normal case while typing, so it counts.
    if (close !== -1 && close + 2 <= offset) return undefined;
    return { start: open, end: close === -1 ? text.length : close + 2 };
}

/** The string literal containing this offset within a span, if any. */
function enclosingString(
    text: string,
    from: number,
    offset: number
): { quote: string; start: number; end: number; value: string } | undefined {
    let index = from;
    while (index < offset) {
        const char = text[index];
        if (char !== "'" && char !== '"') {
            index++;
            continue;
        }
        const quote = char;
        let end = index + 1;
        while (end < text.length && text[end] !== quote && text[end] !== '\n') end++;
        if (offset > index && offset <= end) {
            return { quote, start: index + 1, end, value: text.slice(index + 1, Math.min(end, offset)) };
        }
        index = end + 1;
    }
    return undefined;
}

/**
 * What should be offered at this offset, if anything.
 *
 * Returns `undefined` everywhere except inside the quotes of a `ref` or
 * `source` call, so it can be asked unconditionally.
 */
export function dbtCompletionAt(text: string, offset: number): DbtCompletionRequest | undefined {
    const tag = enclosingTag(text, offset);
    if (!tag) return undefined;

    const inside = text.slice(tag.start, offset);
    const call = /\b(ref|source)\s*\(/.exec(inside);
    if (!call) return undefined;

    const callStart = tag.start + call.index + call[0].length;
    const literal = enclosingString(text, callStart, offset);
    if (!literal) return undefined;

    if (call[1] === 'ref') {
        return { kind: 'model', prefix: literal.value, start: literal.start, end: literal.end };
    }

    // `source('raw', 'events')`: which argument the cursor is in decides what
    // to offer, and the first one narrows the second.
    const before = text.slice(callStart, literal.start - 1);
    const earlier = [...before.matchAll(/(['"])((?:\\.|(?!\1)[^\\])*)\1/g)].map(match => match[2]);
    if (earlier.length === 0) {
        return { kind: 'source', prefix: literal.value, start: literal.start, end: literal.end };
    }
    return {
        kind: 'sourceTable',
        prefix: literal.value,
        sourceName: earlier[earlier.length - 1],
        start: literal.start,
        end: literal.end,
    };
}

/** The names to offer for a request, given what the manifest knows. */
export function dbtCompletionItems(
    request: DbtCompletionRequest,
    project: { modelNames(): string[]; sourceNames(): string[] }
): string[] {
    if (request.kind === 'model') return project.modelNames();

    const pairs = project.sourceNames();
    if (request.kind === 'source') {
        return [...new Set(pairs.map(pair => pair.split('.')[0]))].sort();
    }
    return pairs
        .filter(pair => pair.startsWith(`${request.sourceName}.`))
        .map(pair => pair.slice(pair.indexOf('.') + 1));
}
