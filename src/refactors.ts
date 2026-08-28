/**
 * Source-to-source rewrites behind the code actions.
 *
 * Each one is a pure function over text and an offset returning a single edit,
 * which is what makes them unit-testable and lets the provider apply them as an
 * atomic `WorkspaceEdit` instead of driving the editor.
 */
import { Token, TokenKind, tokenize, isTrivia } from './lexer';
import { findKeywordTokens } from './keywords';

export interface TextEdit {
    start: number;
    end: number;
    newText: string;
}

interface Analysis {
    tokens: Token[];
    sig: number[];
    keywords: Set<number>;
    text: string;
}

function analyze(text: string): Analysis {
    const tokens = tokenize(text);
    const keywords = findKeywordTokens(tokens);
    const sig: number[] = [];
    for (let i = 0; i < tokens.length; i++) {
        if (!isTrivia(tokens[i])) sig.push(i);
    }
    return { tokens, sig, keywords, text };
}

function at(a: Analysis, j: number): Token | undefined {
    const idx = a.sig[j];
    return idx === undefined ? undefined : a.tokens[idx];
}

function isKw(a: Analysis, j: number, upper?: string): boolean {
    const idx = a.sig[j];
    if (idx === undefined) return false;
    const t = a.tokens[idx];
    if (t.kind !== TokenKind.Word || !a.keywords.has(idx)) return false;
    return upper === undefined || t.upper === upper;
}

function isOpen(t: Token | undefined): boolean {
    return !!t && t.kind === TokenKind.Punct && (t.text === '(' || t.text === '[');
}

function isClose(t: Token | undefined): boolean {
    return !!t && t.kind === TokenKind.Punct && (t.text === ')' || t.text === ']');
}

/** Significant index of the last token starting at or before `offset`. */
function sigAt(a: Analysis, offset: number): number {
    let result = -1;
    for (let j = 0; j < a.sig.length; j++) {
        if (at(a, j)!.start <= offset) result = j;
        else break;
    }
    return result;
}

/** Significant-index bounds of the statement containing `offset`. */
function statementBounds(a: Analysis, offset: number): { from: number; to: number } {
    const cursor = Math.max(0, sigAt(a, offset));
    let from = 0;
    for (let j = cursor; j >= 0; j--) {
        const t = at(a, j)!;
        if (t.kind === TokenKind.Punct && t.text === ';') {
            from = j + 1;
            break;
        }
    }
    let to = a.sig.length;
    for (let j = cursor + 1; j < a.sig.length; j++) {
        const t = at(a, j)!;
        if (t.kind === TokenKind.Punct && t.text === ';') {
            to = j;
            break;
        }
    }
    return { from, to };
}

/** First depth-0 occurrence of a keyword between two significant indices. */
function findKeywordAtDepth0(a: Analysis, from: number, to: number, upper: string): number {
    let depth = 0;
    for (let j = from; j < to; j++) {
        const t = at(a, j)!;
        if (isOpen(t)) depth++;
        else if (isClose(t)) depth--;
        else if (depth === 0 && isKw(a, j, upper)) return j;
    }
    return -1;
}

/** Clause keywords that terminate a WHERE body. */
const CLAUSE_TERMINATORS = new Set([
    'GROUP', 'ORDER', 'LIMIT', 'HAVING', 'QUALIFY', 'SETTINGS', 'FORMAT', 'UNION',
    'INTERSECT', 'EXCEPT', 'INTO', 'WINDOW', 'OFFSET',
]);

/** Significant index where the clause body starting at `from` ends. */
function clauseBodyEnd(a: Analysis, from: number, to: number): number {
    let depth = 0;
    for (let j = from; j < to; j++) {
        const t = at(a, j)!;
        if (isOpen(t)) depth++;
        else if (isClose(t)) depth--;
        else if (depth === 0 && isKw(a, j) && CLAUSE_TERMINATORS.has(t.upper)) return j;
    }
    return to;
}

// ── SELECT * expansion ───────────────────────────────────────────────────────

export interface SelectStarTarget {
    /** Offset range of the `*`. */
    edit: { start: number; end: number };
    /** Table reference the star belongs to, if a single one is resolvable. */
    table?: { database?: string; table: string };
}

/** Locate the `SELECT *` whose statement contains `offset`. */
export function findSelectStarTarget(text: string, offset: number): SelectStarTarget | null {
    const a = analyze(text);
    const { from, to } = statementBounds(a, offset);

    const selectAt = findKeywordAtDepth0(a, from, to, 'SELECT');
    if (selectAt < 0) return null;

    let starSig = selectAt + 1;
    if (isKw(a, starSig, 'DISTINCT')) starSig++;
    const star = at(a, starSig);
    if (!star || star.kind !== TokenKind.Operator || star.text !== '*') return null;

    const target: SelectStarTarget = { edit: { start: star.start, end: star.end } };

    const fromAt = findKeywordAtDepth0(a, selectAt, to, 'FROM');
    if (fromAt < 0) return target;

    const first = at(a, fromAt + 1);
    if (!first) return target;
    const isName =
        first.kind === TokenKind.Word || first.kind === TokenKind.BacktickIdent || first.kind === TokenKind.QuotedIdent;
    if (!isName || a.keywords.has(a.sig[fromAt + 1])) return target;
    // Table functions and subqueries have no schema entry.
    if (isOpen(at(a, fromAt + 2))) return target;

    const second = at(a, fromAt + 2);
    if (second && second.kind === TokenKind.Punct && second.text === '.') {
        const third = at(a, fromAt + 3);
        if (third) {
            target.table = { database: strip(first.text), table: strip(third.text) };
            return target;
        }
    }
    target.table = { table: strip(first.text) };
    return target;
}

function strip(text: string): string {
    if (text.length >= 2 && ((text[0] === '`' && text.endsWith('`')) || (text[0] === '"' && text.endsWith('"')))) {
        return text.slice(1, -1);
    }
    return text;
}

export function expandSelectStar(text: string, offset: number, columns: string[]): TextEdit | null {
    const target = findSelectStarTarget(text, offset);
    if (!target || columns.length === 0) return null;
    return { start: target.edit.start, end: target.edit.end, newText: columns.join(', ') };
}

// ── CASE → multiIf ───────────────────────────────────────────────────────────

/** The CASE expression enclosing `offset`, as significant-index bounds. */
function enclosingCase(a: Analysis, offset: number): { start: number; end: number } | null {
    const cursor = sigAt(a, offset);
    if (cursor < 0) return null;

    for (let j = cursor; j >= 0; j--) {
        if (!isKw(a, j, 'CASE')) continue;
        let depth = 0;
        for (let k = j + 1; k < a.sig.length; k++) {
            if (isKw(a, k, 'CASE')) depth++;
            else if (isKw(a, k, 'END')) {
                if (depth === 0) {
                    if (k >= cursor) return { start: j, end: k };
                    break;
                }
                depth--;
            }
        }
    }
    return null;
}

export function caseToMultiIf(text: string, offset: number): TextEdit | null {
    const a = analyze(text);
    const bounds = enclosingCase(a, offset);
    if (!bounds) return null;

    // Only the searched form `CASE WHEN …` maps directly onto multiIf.
    if (!isKw(a, bounds.start + 1, 'WHEN')) return null;

    const parts: string[] = [];
    let elseText: string | null = null;
    let j = bounds.start + 1;
    let depth = 0;

    const slice = (fromSig: number, toSig: number): string =>
        text.slice(at(a, fromSig)!.start, at(a, toSig - 1)!.end).trim();

    while (j < bounds.end) {
        if (isKw(a, j, 'WHEN') && depth === 0) {
            const thenAt = seekKeyword(a, j + 1, bounds.end, 'THEN');
            if (thenAt < 0) return null;
            const nextAt = seekBranchEnd(a, thenAt + 1, bounds.end);
            parts.push(slice(j + 1, thenAt));
            parts.push(slice(thenAt + 1, nextAt));
            j = nextAt;
            continue;
        }
        if (isKw(a, j, 'ELSE') && depth === 0) {
            elseText = slice(j + 1, bounds.end);
            break;
        }
        const t = at(a, j)!;
        if (isKw(a, j, 'CASE')) depth++;
        else if (isKw(a, j, 'END')) depth--;
        else if (isOpen(t)) depth++;
        else if (isClose(t)) depth--;
        j++;
    }

    if (parts.length === 0) return null;
    parts.push(elseText ?? 'NULL');

    return {
        start: at(a, bounds.start)!.start,
        end: at(a, bounds.end)!.end,
        newText: `multiIf(${parts.join(', ')})`,
    };
}

function seekKeyword(a: Analysis, from: number, to: number, upper: string): number {
    let depth = 0;
    for (let j = from; j < to; j++) {
        const t = at(a, j)!;
        if (isOpen(t) || isKw(a, j, 'CASE')) depth++;
        else if (isClose(t) || isKw(a, j, 'END')) depth--;
        else if (depth === 0 && isKw(a, j, upper)) return j;
    }
    return -1;
}

/** End of a THEN branch: the next depth-0 WHEN, ELSE, or the closing END. */
function seekBranchEnd(a: Analysis, from: number, to: number): number {
    let depth = 0;
    for (let j = from; j < to; j++) {
        const t = at(a, j)!;
        if (isOpen(t) || isKw(a, j, 'CASE')) depth++;
        else if (isClose(t) || isKw(a, j, 'END')) depth--;
        else if (depth === 0 && (isKw(a, j, 'WHEN') || isKw(a, j, 'ELSE'))) return j;
    }
    return to;
}

// ── Move a filter into PREWHERE ──────────────────────────────────────────────

export interface PrewhereCandidate {
    /** The AND-term that would move, as an offset range. */
    term: { start: number; end: number };
    text: string;
}

/**
 * The top-level AND-term of WHERE that contains `offset`, when moving it into a
 * PREWHERE is possible (no PREWHERE yet, and at least one term stays behind).
 */
export function findPrewhereCandidate(text: string, offset: number): PrewhereCandidate | null {
    const a = analyze(text);
    const { from, to } = statementBounds(a, offset);
    if (findKeywordAtDepth0(a, from, to, 'PREWHERE') >= 0) return null;
    if (findKeywordAtDepth0(a, from, to, 'SELECT') < 0) return null;

    const whereAt = findKeywordAtDepth0(a, from, to, 'WHERE');
    if (whereAt < 0) return null;
    const bodyEnd = clauseBodyEnd(a, whereAt + 1, to);
    if (bodyEnd <= whereAt + 1) return null;

    const terms = splitAndTerms(a, whereAt + 1, bodyEnd);
    if (terms.length < 2) return null;

    const cursor = sigAt(a, offset);
    const chosen =
        terms.find(t => cursor >= t.from && cursor < t.to) ??
        (cursor <= whereAt ? terms[0] : undefined);
    if (!chosen) return null;

    const start = at(a, chosen.from)!.start;
    const end = at(a, chosen.to - 1)!.end;
    return { term: { start, end }, text: text.slice(start, end).trim() };
}

function splitAndTerms(a: Analysis, from: number, to: number): Array<{ from: number; to: number }> {
    const terms: Array<{ from: number; to: number }> = [];
    let depth = 0;
    let start = from;
    for (let j = from; j < to; j++) {
        const t = at(a, j)!;
        if (isOpen(t)) depth++;
        else if (isClose(t)) depth--;
        else if (depth === 0 && isKw(a, j, 'OR')) return []; // OR makes the split unsafe
        else if (depth === 0 && isKw(a, j, 'AND')) {
            terms.push({ from: start, to: j });
            start = j + 1;
        }
    }
    if (start < to) terms.push({ from: start, to });
    return terms;
}

/**
 * Rewrite WHERE so the chosen term becomes a PREWHERE.
 */
export function moveToPrewhere(text: string, offset: number): TextEdit | null {
    const candidate = findPrewhereCandidate(text, offset);
    if (!candidate) return null;

    const a = analyze(text);
    const { from, to } = statementBounds(a, offset);
    const whereAt = findKeywordAtDepth0(a, from, to, 'WHERE');
    if (whereAt < 0) return null;
    const bodyEnd = clauseBodyEnd(a, whereAt + 1, to);
    const terms = splitAndTerms(a, whereAt + 1, bodyEnd);
    if (terms.length < 2) return null;

    const kept: string[] = [];
    let moved: string | null = null;
    for (const term of terms) {
        const body = text.slice(at(a, term.from)!.start, at(a, term.to - 1)!.end).trim();
        if (at(a, term.from)!.start === candidate.term.start) moved = body;
        else kept.push(body);
    }
    if (!moved || kept.length === 0) return null;

    const whereToken = at(a, whereAt)!;
    const lower = whereToken.text === whereToken.text.toLowerCase();
    const prewhereWord = lower ? 'prewhere' : 'PREWHERE';
    const whereWord = whereToken.text;
    const andWord = lower ? 'and' : 'AND';

    const start = whereToken.start;
    const end = at(a, bodyEnd - 1)!.end;
    const newText = `${prewhereWord} ${moved} ${whereWord} ${kept.join(` ${andWord} `)}`;
    return { start, end, newText };
}

// ── indexHint ────────────────────────────────────────────────────────────────

/**
 * The equality comparison under the cursor inside WHERE/PREWHERE, if any.
 */
export function findIndexHintTarget(text: string, offset: number): TextEdit | null {
    const a = analyze(text);
    const { from, to } = statementBounds(a, offset);

    for (const clause of ['WHERE', 'PREWHERE'] as const) {
        const clauseAt = findKeywordAtDepth0(a, from, to, clause);
        if (clauseAt < 0) continue;
        const bodyEnd = clauseBodyEnd(a, clauseAt + 1, to);
        const terms = splitAndTerms(a, clauseAt + 1, bodyEnd);
        const cursor = sigAt(a, offset);
        for (const term of terms) {
            if (cursor < term.from || cursor >= term.to) continue;
            const body = text.slice(at(a, term.from)!.start, at(a, term.to - 1)!.end).trim();
            if (/^indexHint\s*\(/i.test(body)) return null;
            // Only equality comparisons benefit from an index hint.
            let hasEquals = false;
            let depth = 0;
            for (let j = term.from; j < term.to; j++) {
                const t = at(a, j)!;
                if (isOpen(t)) depth++;
                else if (isClose(t)) depth--;
                else if (depth === 0 && t.kind === TokenKind.Operator && t.text === '=') hasEquals = true;
            }
            if (!hasEquals) return null;
            return {
                start: at(a, term.from)!.start,
                end: at(a, term.to - 1)!.end,
                newText: `indexHint(${body})`,
            };
        }
    }
    return null;
}
