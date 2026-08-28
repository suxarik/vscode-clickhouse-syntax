/**
 * SQL context detection for ClickHouse queries.
 *
 * Clause detection walks *backwards* from the cursor through the token stream,
 * so the answer depends on where the cursor is rather than on which keywords
 * happen to appear somewhere in the document.
 */
import * as vscode from 'vscode';
import { CH_DETECTION_PATTERNS } from './constants';
import { Token, TokenKind, tokenize, isTrivia } from './lexer';
import { findKeywordTokens } from './keywords';

export interface TableRef {
    fullRef: string;
    database?: string;
    table: string;
    alias?: string;
    /** Offset of the table reference in the document. */
    start: number;
}

export interface SqlContext {
    /** Nearest clause keyword before the cursor, e.g. `SELECT`, `ORDER BY`. */
    clause: string;
    /** Offset where that clause keyword starts, or -1. */
    clauseStart: number;
    /** Offset where the current statement starts. */
    statementStart: number;
    /** Open-paren depth at the cursor, relative to the statement. */
    depth: number;
    /** Cursor sits inside a string literal. */
    inString: boolean;
    /** Cursor sits inside a comment. */
    inComment: boolean;
    /** Tables visible from the cursor's query scope, with aliases resolved. */
    tables: TableRef[];
    /** Names introduced by WITH ... AS (...) in this statement. */
    ctes: string[];
    /** Text from the start of the document to the cursor (legacy field). */
    prevText: string;
}

/** Clause heads recognised by `getSqlContext`, longest first. */
const CLAUSE_HEADS: string[][] = [
    ['CREATE', 'MATERIALIZED', 'VIEW'],
    ['LEFT', 'ARRAY', 'JOIN'],
    ['INSERT', 'INTO'], ['CREATE', 'TABLE'], ['ALTER', 'TABLE'], ['INTO', 'OUTFILE'],
    ['ARRAY', 'JOIN'], ['GROUP', 'BY'], ['ORDER', 'BY'], ['PARTITION', 'BY'],
    ['LIMIT', 'BY'], ['SAMPLE', 'BY'], ['PRIMARY', 'KEY'],
    ['SELECT'], ['FROM'], ['PREWHERE'], ['WHERE'], ['HAVING'], ['QUALIFY'],
    ['WINDOW'], ['LIMIT'], ['OFFSET'], ['SETTINGS'], ['FORMAT'], ['VALUES'],
    ['JOIN'], ['ON'], ['USING'], ['SET'], ['WITH'], ['ENGINE'], ['TTL'],
];

const JOIN_MODIFIERS = new Set([
    'GLOBAL', 'LEFT', 'RIGHT', 'FULL', 'INNER', 'CROSS', 'OUTER',
    'ANY', 'ALL', 'SEMI', 'ANTI', 'ASOF', 'ARRAY', 'PASTE',
]);

/** Words that may follow a table reference without being its alias. */
const NOT_AN_ALIAS = new Set([
    'FINAL', 'SAMPLE', 'PREWHERE', 'WHERE', 'GROUP', 'ORDER', 'LIMIT', 'OFFSET',
    'SETTINGS', 'FORMAT', 'HAVING', 'QUALIFY', 'WINDOW', 'UNION', 'INTERSECT',
    'EXCEPT', 'ON', 'USING', 'JOIN', 'AS', 'INTO', 'VALUES', 'SELECT', 'WITH',
    ...JOIN_MODIFIERS,
]);

/** A quoted literal is terminated when it has a closing delimiter of its own. */
function isTerminated(text: string): boolean {
    if (text.length < 2) return false;
    if (text.startsWith('$')) {
        const close = text.indexOf('$', 1);
        if (close < 0) return false;
        const tag = text.slice(0, close + 1);
        return text.length > tag.length && text.endsWith(tag);
    }
    return text[text.length - 1] === text[0];
}

// ── Language detection ───────────────────────────────────────────────────────

/**
 * Strip comments and string bodies so detection cannot fire on prose.
 */
function detectionSample(text: string): string {
    const sample = text.length > 65536 ? text.slice(0, 65536) : text;
    const tokens = tokenize(sample);
    let out = '';
    for (const token of tokens) {
        switch (token.kind) {
            case TokenKind.LineComment:
            case TokenKind.BlockComment:
                out += ' ';
                break;
            case TokenKind.String:
            case TokenKind.Heredoc:
                out += "''";
                break;
            default:
                out += token.text;
        }
    }
    return out;
}

export function isClickHouseSQL(text: string): boolean {
    if (!text.trim()) return false;
    const sample = detectionSample(text);
    return CH_DETECTION_PATTERNS.some(re => re.test(sample));
}

// ── Token helpers ────────────────────────────────────────────────────────────

interface Scan {
    tokens: Token[];
    sig: number[];
    keywords: Set<number>;
}

function scan(text: string): Scan {
    const tokens = tokenize(text);
    const keywords = findKeywordTokens(tokens);
    const sig: number[] = [];
    for (let i = 0; i < tokens.length; i++) {
        if (!isTrivia(tokens[i])) sig.push(i);
    }
    return { tokens, sig, keywords };
}

function isKeyword(s: Scan, sigIndex: number, upper?: string): boolean {
    const idx = s.sig[sigIndex];
    if (idx === undefined) return false;
    const token = s.tokens[idx];
    if (token.kind !== TokenKind.Word || !s.keywords.has(idx)) return false;
    return upper === undefined || token.upper === upper;
}

function tok(s: Scan, sigIndex: number): Token | undefined {
    const idx = s.sig[sigIndex];
    return idx === undefined ? undefined : s.tokens[idx];
}

function isPunct(s: Scan, sigIndex: number, text: string): boolean {
    const t = tok(s, sigIndex);
    return !!t && t.kind === TokenKind.Punct && t.text === text;
}

/** Significant-token index at or immediately before `offset`. */
function sigIndexBefore(s: Scan, offset: number): number {
    let lo = 0;
    let hi = s.sig.length - 1;
    let result = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (s.tokens[s.sig[mid]].start < offset) {
            result = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return result;
}

/** Match a clause head ending at (and including) significant index `j`. */
function clauseHeadAt(s: Scan, j: number): { name: string; start: number; startSig: number } | null {
    if (!isKeyword(s, j)) return null;
    const upper = tok(s, j)!.upper;

    // A join run: walk back over its modifiers so `LEFT JOIN` is reported whole.
    if (upper === 'JOIN') {
        let k = j;
        while (k > 0 && isKeyword(s, k - 1) && JOIN_MODIFIERS.has(tok(s, k - 1)!.upper)) k--;
        const words: string[] = [];
        for (let i = k; i <= j; i++) words.push(tok(s, i)!.upper);
        return { name: words.join(' '), start: tok(s, k)!.start, startSig: k };
    }

    for (const head of CLAUSE_HEADS) {
        const startSig = j - head.length + 1;
        if (startSig < 0) continue;
        let ok = true;
        for (let k = 0; k < head.length; k++) {
            if (!isKeyword(s, startSig + k, head[k])) {
                ok = false;
                break;
            }
        }
        if (ok) return { name: head.join(' '), start: tok(s, startSig)!.start, startSig };
    }
    return null;
}

// ── Table references ─────────────────────────────────────────────────────────

function readTableRef(s: Scan, j: number): { ref: TableRef; next: number } | null {
    const first = tok(s, j);
    if (!first) return null;
    const isName =
        first.kind === TokenKind.Word || first.kind === TokenKind.BacktickIdent || first.kind === TokenKind.QuotedIdent;
    if (!isName || s.keywords.has(s.sig[j])) return null;

    // A table function (`numbers(10)`, `s3(...)`) is not a schema table.
    if (isPunct(s, j + 1, '(')) return null;

    let database: string | undefined;
    let table = unquote(first.text);
    let end = j;

    if (isPunct(s, j + 1, '.')) {
        const second = tok(s, j + 2);
        if (second && (second.kind === TokenKind.Word || second.kind === TokenKind.BacktickIdent || second.kind === TokenKind.QuotedIdent)) {
            database = table;
            table = unquote(second.text);
            end = j + 2;
        }
    }

    const fullRef = database ? `${database}.${table}` : table;
    const ref: TableRef = { fullRef, table, start: first.start };
    if (database) ref.database = database;

    // Optional alias, with or without AS.
    let aliasSig = end + 1;
    if (isKeyword(s, aliasSig, 'AS')) aliasSig++;
    const aliasToken = tok(s, aliasSig);
    if (
        aliasToken &&
        (aliasToken.kind === TokenKind.Word ||
            aliasToken.kind === TokenKind.BacktickIdent ||
            aliasToken.kind === TokenKind.QuotedIdent) &&
        !(aliasToken.kind === TokenKind.Word && NOT_AN_ALIAS.has(aliasToken.upper)) &&
        !isPunct(s, aliasSig + 1, '(')
    ) {
        ref.alias = unquote(aliasToken.text);
        end = aliasSig;
    }

    return { ref, next: end + 1 };
}

function unquote(text: string): string {
    if (text.length >= 2) {
        const first = text[0];
        const last = text[text.length - 1];
        if ((first === '`' && last === '`') || (first === '"' && last === '"')) {
            return text.slice(1, -1).replace(/\\(.)/g, '$1');
        }
    }
    return text;
}

/**
 * Table references between two significant indices, skipping nested groups so a
 * subquery's own FROM does not leak into the outer scope.
 */
function collectTables(s: Scan, fromSig: number, toSig: number): TableRef[] {
    const refs: TableRef[] = [];
    let depth = 0;
    for (let j = fromSig; j < toSig && j < s.sig.length; j++) {
        const t = tok(s, j)!;
        if (t.kind === TokenKind.Punct && (t.text === '(' || t.text === '[')) {
            depth++;
            continue;
        }
        if (t.kind === TokenKind.Punct && (t.text === ')' || t.text === ']')) {
            depth--;
            continue;
        }
        if (depth !== 0) continue;
        if (!isKeyword(s, j)) continue;
        const upper = t.upper;
        if (upper === 'FROM' || upper === 'JOIN') {
            const read = readTableRef(s, j + 1);
            if (read) {
                refs.push(read.ref);
                j = read.next - 1;
            }
        }
    }
    return refs;
}

function collectCtes(s: Scan, fromSig: number, toSig: number): string[] {
    const names: string[] = [];
    let depth = 0;
    for (let j = fromSig; j < toSig && j < s.sig.length; j++) {
        const t = tok(s, j)!;
        if (t.kind === TokenKind.Punct && (t.text === '(' || t.text === '[')) {
            depth++;
            continue;
        }
        if (t.kind === TokenKind.Punct && (t.text === ')' || t.text === ']')) {
            depth--;
            continue;
        }
        if (depth !== 0) continue;
        // name AS ( ...
        if (isKeyword(s, j, 'AS') && isPunct(s, j + 1, '(')) {
            const name = tok(s, j - 1);
            if (name && (name.kind === TokenKind.Word || name.kind === TokenKind.BacktickIdent) && !s.keywords.has(s.sig[j - 1])) {
                names.push(unquote(name.text));
            }
        }
    }
    return names;
}

// ── Public context API ───────────────────────────────────────────────────────

export function getSqlContextFromText(text: string, offset: number): SqlContext {
    const s = scan(text);
    const cursor = sigIndexBefore(s, offset);

    const context: SqlContext = {
        clause: '',
        clauseStart: -1,
        statementStart: 0,
        depth: 0,
        inString: false,
        inComment: false,
        tables: [],
        ctes: [],
        prevText: text.slice(0, offset),
    };

    // Inside a string or comment nothing else is meaningful. A cursor at the very
    // end of a line comment — or of an unterminated literal — still counts as inside.
    for (const token of s.tokens) {
        if (token.start >= offset) break;
        if (offset > token.end) continue;
        const atEnd = offset === token.end;
        switch (token.kind) {
            case TokenKind.LineComment:
                context.inComment = true;
                break;
            case TokenKind.BlockComment:
                if (!atEnd || !token.text.endsWith('*/')) context.inComment = true;
                break;
            case TokenKind.String:
            case TokenKind.Heredoc:
                if (!atEnd || !isTerminated(token.text)) context.inString = true;
                break;
            default:
                break;
        }
    }
    if (context.inString || context.inComment) return context;

    // Statement bounds: nearest top-level `;` either side of the cursor.
    let startSig = 0;
    for (let j = cursor; j >= 0; j--) {
        if (isPunct(s, j, ';')) {
            startSig = j + 1;
            break;
        }
    }
    let endSig = s.sig.length;
    for (let j = cursor + 1; j < s.sig.length; j++) {
        if (isPunct(s, j, ';')) {
            endSig = j;
            break;
        }
    }
    context.statementStart = tok(s, startSig)?.start ?? offset;

    // Depth, and the innermost group that encloses the cursor.
    let depth = 0;
    let scopeStartSig = startSig;
    const openStack: number[] = [];
    for (let j = startSig; j <= cursor; j++) {
        const t = tok(s, j)!;
        if (t.kind === TokenKind.Punct && (t.text === '(' || t.text === '[')) {
            openStack.push(j);
            depth++;
        } else if (t.kind === TokenKind.Punct && (t.text === ')' || t.text === ']')) {
            openStack.pop();
            if (depth > 0) depth--;
        }
    }
    context.depth = depth;
    if (openStack.length > 0) scopeStartSig = openStack[openStack.length - 1] + 1;

    // Nearest clause head before the cursor, widening outwards through enclosing
    // groups when the innermost one holds no clause of its own.
    let searchStart = scopeStartSig;
    let openIndex = openStack.length - 1;
    let clause: { name: string; start: number; startSig: number } | null = null;
    let clauseScopeStart = searchStart;

    for (;;) {
        let groupDepth = 0;
        for (let j = cursor; j >= searchStart; j--) {
            const t = tok(s, j)!;
            if (t.kind === TokenKind.Punct && (t.text === ')' || t.text === ']')) {
                groupDepth++;
                continue;
            }
            if (t.kind === TokenKind.Punct && (t.text === '(' || t.text === '[')) {
                if (groupDepth > 0) groupDepth--;
                continue;
            }
            if (groupDepth !== 0) continue;
            const head = clauseHeadAt(s, j);
            if (head) {
                clause = head;
                break;
            }
        }
        if (clause || openIndex < 0) {
            clauseScopeStart = searchStart;
            break;
        }
        openIndex--;
        searchStart = openIndex >= 0 ? openStack[openIndex] + 1 : startSig;
    }

    if (clause) {
        context.clause = clause.name;
        context.clauseStart = clause.start;
    }

    // Tables in scope: the enclosing query scope, falling back to the statement.
    const scopeEndSig = (() => {
        if (clauseScopeStart <= startSig) return endSig;
        let d = 1;
        for (let j = clauseScopeStart; j < endSig; j++) {
            const t = tok(s, j)!;
            if (t.kind === TokenKind.Punct && (t.text === '(' || t.text === '[')) d++;
            else if (t.kind === TokenKind.Punct && (t.text === ')' || t.text === ']')) {
                d--;
                if (d === 0) return j;
            }
        }
        return endSig;
    })();

    context.tables = collectTables(s, clauseScopeStart, scopeEndSig);
    if (context.tables.length === 0 && clauseScopeStart > startSig) {
        context.tables = collectTables(s, startSig, endSig);
    }
    context.ctes = collectCtes(s, startSig, endSig);

    return context;
}

export function getSqlContext(document: vscode.TextDocument, position: vscode.Position): SqlContext {
    return getSqlContextFromText(document.getText(), document.offsetAt(position));
}

export function getWordBeforeCursor(document: vscode.TextDocument, position: vscode.Position): string {
    const lineText = document.lineAt(position.line).text;
    const beforeCursor = lineText.substring(0, position.character);
    const match = beforeCursor.match(/([a-zA-Z_][a-zA-Z0-9_]*)\s*$/);
    return match ? match[1] : '';
}

/**
 * Qualifier immediately before the cursor: `events.`, `e.`, `analytics.events.`.
 */
export function isAfterDot(
    document: vscode.TextDocument,
    position: vscode.Position
): { isAfter: boolean; prefix: string; qualifier: string[] } {
    const lineText = document.lineAt(position.line).text;
    const beforeCursor = lineText.substring(0, position.character);
    const match = beforeCursor.match(/((?:[a-zA-Z_][a-zA-Z0-9_]*|`[^`]*`)(?:\s*\.\s*(?:[a-zA-Z_][a-zA-Z0-9_]*|`[^`]*`))*)\s*\.\s*[a-zA-Z0-9_]*$/);
    if (!match) return { isAfter: false, prefix: '', qualifier: [] };
    const qualifier = match[1].split('.').map(part => unquote(part.trim()));
    return { isAfter: true, prefix: qualifier[qualifier.length - 1], qualifier };
}

/**
 * Every table reference in a query, with the offset of each reference so
 * diagnostics can point at the right occurrence.
 */
export function extractTableReferences(text: string): TableRef[] {
    const s = scan(text);
    const refs: TableRef[] = [];
    for (let j = 0; j < s.sig.length; j++) {
        if (!isKeyword(s, j)) continue;
        const upper = tok(s, j)!.upper;
        if (upper !== 'FROM' && upper !== 'JOIN') continue;
        const read = readTableRef(s, j + 1);
        if (read) {
            refs.push(read.ref);
            j = read.next - 1;
        }
    }
    return refs;
}

export function hasClause(text: string, clause: string): boolean {
    const s = scan(text);
    const words = clause.toUpperCase().split(/\s+/);
    for (let j = 0; j + words.length <= s.sig.length; j++) {
        let ok = true;
        for (let k = 0; k < words.length; k++) {
            if (!isKeyword(s, j + k, words[k])) {
                ok = false;
                break;
            }
        }
        if (ok) return true;
    }
    return false;
}

export interface StatementRange {
    start: number;
    end: number;
    text: string;
}

/** Split a document into statements at top-level semicolons. */
export function splitStatements(text: string): StatementRange[] {
    const s = scan(text);
    const ranges: StatementRange[] = [];
    let start = 0;
    for (let j = 0; j < s.sig.length; j++) {
        if (isPunct(s, j, ';')) {
            const end = tok(s, j)!.end;
            if (text.slice(start, end).trim()) ranges.push({ start, end, text: text.slice(start, end) });
            start = end;
        }
    }
    if (text.slice(start).trim()) ranges.push({ start, end: text.length, text: text.slice(start) });
    return ranges;
}

/** Names bound by `WITH <name> AS (...)` anywhere in the text. */
export function extractCteNames(text: string): string[] {
    const s = scan(text);
    return collectCtes(s, 0, s.sig.length);
}

/**
 * Offsets of keyword occurrences, skipping strings and comments.
 * `phrase` may contain several words, e.g. `NOT IN`.
 */
export function findKeywordOccurrences(text: string, phrase: string): Array<{ start: number; end: number }> {
    const s = scan(text);
    const words = phrase.toUpperCase().split(/\s+/);
    const hits: Array<{ start: number; end: number }> = [];
    for (let j = 0; j + words.length <= s.sig.length; j++) {
        let ok = true;
        for (let k = 0; k < words.length; k++) {
            if (!isKeyword(s, j + k, words[k])) {
                ok = false;
                break;
            }
        }
        if (ok) hits.push({ start: tok(s, j)!.start, end: tok(s, j + words.length - 1)!.end });
    }
    return hits;
}

/** Offsets of `SELECT *` (and `SELECT DISTINCT *`) occurrences. */
export function findSelectStar(text: string): Array<{ start: number; end: number }> {
    const s = scan(text);
    const hits: Array<{ start: number; end: number }> = [];
    for (let j = 0; j < s.sig.length; j++) {
        if (!isKeyword(s, j, 'SELECT')) continue;
        let k = j + 1;
        if (isKeyword(s, k, 'DISTINCT')) k++;
        const star = tok(s, k);
        if (star && star.kind === TokenKind.Operator && star.text === '*') {
            hits.push({ start: tok(s, j)!.start, end: star.end });
        }
    }
    return hits;
}

export interface SettingReference {
    name: string;
    start: number;
    end: number;
    /** Literal on the right-hand side, when there is one. */
    value?: string;
    valueKind?: 'number' | 'string' | 'word';
    valueStart?: number;
    valueEnd?: number;
    /** True when the SETTINGS clause belongs to a CREATE/ALTER statement. */
    mergeTree: boolean;
}

/**
 * `name = value` pairs inside every SETTINGS clause of the text.
 */
export function findSettingReferences(text: string): SettingReference[] {
    const s = scan(text);
    const refs: SettingReference[] = [];

    let statementIsDdl = false;
    let atStatementStart = true;

    for (let j = 0; j < s.sig.length; j++) {
        const t = tok(s, j)!;
        if (t.kind === TokenKind.Punct && t.text === ';') {
            atStatementStart = true;
            continue;
        }
        if (atStatementStart) {
            statementIsDdl =
                t.kind === TokenKind.Word &&
                ['CREATE', 'ALTER', 'ATTACH'].includes(t.upper);
            atStatementStart = false;
        }
        if (!isKeyword(s, j, 'SETTINGS')) continue;

        // Walk the assignment list until the clause ends.
        let k = j + 1;
        let depth = 0;
        for (; k < s.sig.length; k++) {
            const cur = tok(s, k)!;
            if (cur.kind === TokenKind.Punct && (cur.text === '(' || cur.text === '[')) {
                depth++;
                continue;
            }
            if (cur.kind === TokenKind.Punct && (cur.text === ')' || cur.text === ']')) {
                if (depth === 0) break;
                depth--;
                continue;
            }
            if (depth > 0) continue;
            if (cur.kind === TokenKind.Punct && cur.text === ';') break;
            if (cur.kind === TokenKind.Punct && cur.text === ',') continue;
            if (isKeyword(s, k) && cur.upper !== 'SETTINGS') break;
            if (cur.kind !== TokenKind.Word) continue;

            const eq = tok(s, k + 1);
            if (!eq || eq.kind !== TokenKind.Operator || eq.text !== '=') continue;

            const ref: SettingReference = {
                name: cur.text,
                start: cur.start,
                end: cur.end,
                mergeTree: statementIsDdl,
            };
            const value = tok(s, k + 2);
            if (value) {
                if (value.kind === TokenKind.Number) ref.valueKind = 'number';
                else if (value.kind === TokenKind.String) ref.valueKind = 'string';
                else if (value.kind === TokenKind.Word) ref.valueKind = 'word';
                if (ref.valueKind) {
                    ref.value = value.text;
                    ref.valueStart = value.start;
                    ref.valueEnd = value.end;
                }
            }
            refs.push(ref);
            k += 2;
        }
        j = Math.max(j, k - 1);
    }

    return refs;
}
