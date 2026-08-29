/**
 * Tokenizer for ClickHouse SQL.
 *
 * Everything that needs to reason about SQL text — clause detection, keyword
 * casing, formatting — goes through this instead of running regexes over raw
 * source. That is what keeps identifiers, string bodies and comment text from
 * being mistaken for keywords.
 */

export enum TokenKind {
    Whitespace = 'whitespace',
    LineComment = 'lineComment',
    BlockComment = 'blockComment',
    String = 'string',
    QuotedIdent = 'quotedIdent',
    BacktickIdent = 'backtickIdent',
    Heredoc = 'heredoc',
    Number = 'number',
    Word = 'word',
    Operator = 'operator',
    Punct = 'punct',
    /**
     * A Jinja tag: `{{ ref('x') }}`, `{% if … %}` or `{# a comment #}`.
     *
     * Lexed whole and left opaque. A dbt model is not ClickHouse SQL until dbt
     * has compiled it, and guessing at what a tag expands to would be worse
     * than admitting we do not know.
     */
    Template = 'template',
    Unknown = 'unknown',
}

export interface Token {
    kind: TokenKind;
    text: string;
    start: number;
    end: number;
    /** Uppercased text. Only meaningful for `Word` tokens; empty otherwise. */
    upper: string;
}

const OPERATORS_3 = ['<=>'];
const OPERATORS_2 = ['->', '::', '>=', '<=', '<>', '!=', '==', '||', '&&', '|>'];
const OPERATOR_CHARS = new Set(['+', '-', '*', '/', '%', '=', '<', '>', '!', '|', '&', '~', '^', '?', ':']);
const PUNCT_CHARS = new Set(['(', ')', '[', ']', '{', '}', ',', ';', '.']);

function isDigit(c: string): boolean {
    return c >= '0' && c <= '9';
}

function isIdentStart(c: string): boolean {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c.charCodeAt(0) > 127;
}

function isIdentPart(c: string): boolean {
    return isIdentStart(c) || isDigit(c) || c === '$';
}

/**
 * Read a quoted run starting at `i`, where `quote` closes it. ClickHouse allows
 * both backslash escapes and the doubled-quote form inside every quoted form.
 */
function readQuoted(text: string, i: number, quote: string): number {
    const n = text.length;
    let p = i + 1;
    while (p < n) {
        const c = text[p];
        if (c === '\\') {
            p += 2;
            continue;
        }
        if (c === quote) {
            if (p + 1 < n && text[p + 1] === quote) {
                p += 2;
                continue;
            }
            return p + 1;
        }
        p++;
    }
    return n; // unterminated — consume to end so callers still make progress
}

/**
 * `$tag$ ... $tag$` heredoc strings. Returns -1 when this `$` does not open one.
 */
function readHeredoc(text: string, i: number): number {
    const close = text.indexOf('$', i + 1);
    if (close < 0) return -1;
    const tag = text.slice(i, close + 1);
    if (!/^\$[A-Za-z0-9_]*\$$/.test(tag)) return -1;
    const end = text.indexOf(tag, close + 1);
    return end < 0 ? text.length : end + tag.length;
}

function readNumber(text: string, i: number): number {
    const n = text.length;
    let p = i;
    if (text[p] === '0' && p + 1 < n && (text[p + 1] === 'x' || text[p + 1] === 'X')) {
        p += 2;
        while (p < n && /[0-9a-fA-F_]/.test(text[p])) p++;
        return p;
    }
    if (text[p] === '0' && p + 1 < n && (text[p + 1] === 'b' || text[p + 1] === 'B')) {
        p += 2;
        while (p < n && /[01_]/.test(text[p])) p++;
        return p;
    }
    while (p < n && (isDigit(text[p]) || text[p] === '_')) p++;
    if (p < n && text[p] === '.' && p + 1 < n && isDigit(text[p + 1])) {
        p++;
        while (p < n && (isDigit(text[p]) || text[p] === '_')) p++;
    } else if (p < n && text[p] === '.' && !isIdentStart(text[p + 1] ?? '')) {
        // trailing "1." form
        p++;
    }
    if (p < n && (text[p] === 'e' || text[p] === 'E')) {
        let q = p + 1;
        if (q < n && (text[q] === '+' || text[q] === '-')) q++;
        if (q < n && isDigit(text[q])) {
            p = q;
            while (p < n && isDigit(text[p])) p++;
        }
    }
    return p;
}

export function tokenize(text: string): Token[] {
    const tokens: Token[] = [];
    const n = text.length;
    let i = 0;

    const push = (kind: TokenKind, start: number, end: number) => {
        const raw = text.slice(start, end);
        tokens.push({
            kind,
            text: raw,
            start,
            end,
            upper: kind === TokenKind.Word ? raw.toUpperCase() : '',
        });
    };

    /** Last significant token, to tell `.5` from the `.1` in `t.1`. */
    let lastSignificant: Token | undefined;
    const pushed = () => {
        for (let k = tokens.length - 1; k >= 0; k--) {
            if (!isTrivia(tokens[k])) return tokens[k];
        }
        return undefined;
    };

    while (i < n) {
        const c = text[i];
        lastSignificant = pushed();

        if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v') {
            const start = i;
            while (i < n && /\s/.test(text[i])) i++;
            push(TokenKind.Whitespace, start, i);
            continue;
        }

        // Jinja: {{ expression }}, {% statement %}, {# comment #}
        if (c === '{' && (text[i + 1] === '{' || text[i + 1] === '%' || text[i + 1] === '#')) {
            const opener = text[i + 1];
            const closer = opener === '{' ? '}}' : opener === '%' ? '%}' : '#}';
            const start = i;
            i += 2;
            while (i < n && text.slice(i, i + 2) !== closer) i++;
            // An unterminated tag runs to the end rather than being abandoned:
            // half a document is worse than one bad token.
            i = i < n ? i + 2 : n;
            push(TokenKind.Template, start, i);
            continue;
        }

        // -- line comment
        if (c === '-' && text[i + 1] === '-') {
            const start = i;
            while (i < n && text[i] !== '\n') i++;
            push(TokenKind.LineComment, start, i);
            continue;
        }

        // # / #! line comment (ClickHouse accepts both)
        if (c === '#') {
            const start = i;
            while (i < n && text[i] !== '\n') i++;
            push(TokenKind.LineComment, start, i);
            continue;
        }

        // /* block comment */ — not nested, matching ClickHouse
        if (c === '/' && text[i + 1] === '*') {
            const start = i;
            const close = text.indexOf('*/', i + 2);
            i = close < 0 ? n : close + 2;
            push(TokenKind.BlockComment, start, i);
            continue;
        }

        if (c === "'") {
            const start = i;
            i = readQuoted(text, i, "'");
            push(TokenKind.String, start, i);
            continue;
        }

        if (c === '"') {
            const start = i;
            i = readQuoted(text, i, '"');
            push(TokenKind.QuotedIdent, start, i);
            continue;
        }

        if (c === '`') {
            const start = i;
            i = readQuoted(text, i, '`');
            push(TokenKind.BacktickIdent, start, i);
            continue;
        }

        if (c === '$') {
            const end = readHeredoc(text, i);
            if (end > 0) {
                const start = i;
                i = end;
                push(TokenKind.Heredoc, start, i);
                continue;
            }
        }

        // A leading `.` starts a number only when no value precedes it; after an
        // identifier, `)` or `]` the dot is an accessor, as in `tup.1`.
        const dotStartsNumber =
            c === '.' &&
            isDigit(text[i + 1] ?? '') &&
            !(
                lastSignificant &&
                (lastSignificant.kind === TokenKind.Word ||
                    lastSignificant.kind === TokenKind.BacktickIdent ||
                    lastSignificant.kind === TokenKind.QuotedIdent ||
                    (lastSignificant.kind === TokenKind.Punct &&
                        (lastSignificant.text === ')' || lastSignificant.text === ']')))
            );

        if (isDigit(c) || dotStartsNumber) {
            const start = i;
            i = readNumber(text, i);
            push(TokenKind.Number, start, i);
            continue;
        }

        if (isIdentStart(c)) {
            const start = i;
            i++;
            while (i < n && isIdentPart(text[i])) i++;
            push(TokenKind.Word, start, i);
            continue;
        }

        if (PUNCT_CHARS.has(c)) {
            push(TokenKind.Punct, i, i + 1);
            i++;
            continue;
        }

        const three = text.slice(i, i + 3);
        if (OPERATORS_3.includes(three)) {
            push(TokenKind.Operator, i, i + 3);
            i += 3;
            continue;
        }

        const two = text.slice(i, i + 2);
        if (OPERATORS_2.includes(two)) {
            push(TokenKind.Operator, i, i + 2);
            i += 2;
            continue;
        }

        if (OPERATOR_CHARS.has(c)) {
            push(TokenKind.Operator, i, i + 1);
            i++;
            continue;
        }

        push(TokenKind.Unknown, i, i + 1);
        i++;
    }

    return tokens;
}

export function isTrivia(token: Token): boolean {
    return (
        token.kind === TokenKind.Whitespace ||
        token.kind === TokenKind.LineComment ||
        token.kind === TokenKind.BlockComment ||
        // `{% if … %}` and `{# … #}` wrap SQL rather than standing in for any,
        // so skipping them leaves the statement between them parseable. `{{ … }}`
        // stands where a value or a name goes and is not trivia.
        isTemplateBlock(token)
    );
}

/** A `{% … %}` or `{# … #}` tag - control flow or a comment, never a value. */
export function isTemplateBlock(token: Token): boolean {
    return (
        token.kind === TokenKind.Template && (token.text.startsWith('{%') || token.text.startsWith('{#'))
    );
}

/** A `{{ … }}` tag, which stands where a name or a value would. */
export function isTemplateExpression(token: Token): boolean {
    return token.kind === TokenKind.Template && token.text.startsWith('{{');
}

export function isComment(token: Token): boolean {
    return token.kind === TokenKind.LineComment || token.kind === TokenKind.BlockComment;
}

/** Indices of every non-trivia token, in order. */
export function significantIndices(tokens: Token[]): number[] {
    const out: number[] = [];
    for (let i = 0; i < tokens.length; i++) {
        if (!isTrivia(tokens[i])) out.push(i);
    }
    return out;
}

/**
 * Index of the token containing `offset`, or -1. A cursor sitting exactly on a
 * token boundary is reported as being inside the token that ends there only when
 * that token is unterminated, so completion still fires right after `foo`.
 */
export function tokenAtOffset(tokens: Token[], offset: number): number {
    let lo = 0;
    let hi = tokens.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const t = tokens[mid];
        if (offset < t.start) hi = mid - 1;
        else if (offset >= t.end) lo = mid + 1;
        else return mid;
    }
    return -1;
}
