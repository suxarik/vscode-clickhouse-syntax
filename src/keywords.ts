/**
 * Keyword classification for ClickHouse SQL.
 *
 * The distinction that matters here is between words that can only ever be
 * keywords and words that are also perfectly ordinary column names. `SELECT` is
 * always a keyword; `first`, `last`, `range`, `row`, `set`, `table`, `database`,
 * `engine`, `partition` and `format` are all real ClickHouse column names — for
 * example `SELECT database, table, engine FROM system.tables` — so they are only
 * treated as keywords when their surroundings prove it.
 */
import { Token, TokenKind } from './lexer';

/** Words that cannot be a bare identifier, so they are always safe to case. */
export const RESERVED = new Set([
    'SELECT', 'DISTINCT', 'FROM', 'WHERE', 'PREWHERE', 'HAVING',
    'LIMIT', 'OFFSET', 'UNION', 'INTERSECT', 'EXCEPT',
    'JOIN', 'ON', 'USING', 'AS', 'AND', 'OR', 'NOT', 'IN',
    'BETWEEN', 'LIKE', 'ILIKE', 'IS', 'NULL', 'TRUE', 'FALSE',
    'CASE', 'WHEN', 'THEN', 'ELSE',
    'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP',
    'RENAME', 'TRUNCATE', 'ATTACH', 'DETACH', 'OPTIMIZE', 'EXCHANGE',
    'DESCRIBE', 'EXPLAIN', 'SHOW', 'USE', 'KILL', 'GRANT', 'REVOKE',
    'INTO', 'VALUES', 'SETTINGS', 'PREWHERE', 'FINAL', 'WITH',
    'EXISTS', 'ASC', 'DESC', 'OVER', 'WINDOW', 'TTL', 'QUALIFY',
]);

/**
 * Words that are keywords *and* ClickHouse function names. Only these need the
 * "followed by `(` means it is a call" check — `left(s, 2)`, `any(x)`,
 * `if(c, a, b)`, `range(10)`, `count()`. Applying that check to every keyword
 * would wrongly demote `SELECT (a + b)`, `FROM (SELECT …)` and `AS (SELECT …)`.
 */
const PAREN_SENSITIVE = new Set([
    'LEFT', 'RIGHT', 'ANY', 'ALL', 'IF', 'MIN', 'MAX', 'RANGE', 'TYPE',
    'ARRAY', 'MAP', 'TUPLE', 'DATE', 'TIME', 'REPLACE', 'POSITION', 'COUNT',
    'SUM', 'AVG', 'INTERVAL', 'ISNULL', 'ROW', 'TO', 'ADD', 'MODIFY', 'CHECK',
    'INDEX', 'GROUP', 'ORDER', 'DEFAULT', 'COMMENT', 'MOVE', 'FETCH', 'VOLUME',
]);

/** Paren-sensitive words that really are followed by `(` when used as keywords. */
export const ALLOW_PAREN = new Set([
    'IN', 'EXISTS', 'OVER', 'USING', 'VALUES', 'CODEC', 'NOT', 'SETTINGS',
    'AND', 'OR', 'AS', 'WITH', 'FROM', 'SELECT', 'SOURCE', 'LAYOUT', 'LIFETIME',
]);

/** Keywords written tight against their parenthesis: `CODEC(ZSTD)`. */
export const TIGHT_PAREN = new Set(['CODEC', 'SOURCE', 'LAYOUT', 'LIFETIME', 'STRUCTURE']);

function isFunctionCall(upper: string, next: Token | undefined): boolean {
    if (!next || next.kind !== TokenKind.Punct || next.text !== '(') return false;
    if (ALLOW_PAREN.has(upper)) return false;
    return PAREN_SENSITIVE.has(upper);
}

/** Modifiers that may precede JOIN, in any combination. */
const JOIN_MODIFIERS = new Set([
    'GLOBAL', 'LEFT', 'RIGHT', 'FULL', 'INNER', 'CROSS', 'OUTER',
    'ANY', 'ALL', 'SEMI', 'ANTI', 'ASOF', 'ARRAY', 'PASTE',
]);

/** Words that form a clause when directly followed by BY. */
const BY_HEADS = new Set(['GROUP', 'ORDER', 'PARTITION', 'SAMPLE', 'LIMIT', 'CLUSTER', 'DISTRIBUTED']);

/** Multi-word keyword sequences, matched greedily before anything else. */
const PHRASES: string[][] = [
    ['SHOW', 'CREATE', 'TABLE'], ['SHOW', 'CREATE', 'DATABASE'], ['SHOW', 'CREATE', 'DICTIONARY'],
    ['CREATE', 'TEMPORARY', 'TABLE'], ['CREATE', 'MATERIALIZED', 'VIEW'], ['CREATE', 'LIVE', 'VIEW'],
    ['CREATE', 'OR', 'REPLACE', 'VIEW'], ['CREATE', 'WINDOW', 'VIEW'],
    ['CREATE', 'TABLE'], ['CREATE', 'VIEW'], ['CREATE', 'DATABASE'], ['CREATE', 'DICTIONARY'],
    ['CREATE', 'FUNCTION'], ['CREATE', 'ROLE'], ['CREATE', 'USER'], ['CREATE', 'QUOTA'],
    ['ALTER', 'TABLE'], ['ALTER', 'DATABASE'], ['ALTER', 'USER'],
    ['DROP', 'TABLE'], ['DROP', 'DATABASE'], ['DROP', 'VIEW'], ['DROP', 'DICTIONARY'], ['DROP', 'FUNCTION'],
    ['TRUNCATE', 'TABLE'], ['ATTACH', 'TABLE'], ['DETACH', 'TABLE'], ['ATTACH', 'DATABASE'],
    ['RENAME', 'TABLE'], ['RENAME', 'DATABASE'], ['RENAME', 'COLUMN'], ['EXCHANGE', 'TABLES'],
    ['OPTIMIZE', 'TABLE'], ['DESCRIBE', 'TABLE'], ['EXISTS', 'TABLE'], ['EXISTS', 'DATABASE'],
    ['SHOW', 'TABLES'], ['SHOW', 'DATABASES'], ['SHOW', 'DICTIONARIES'], ['SHOW', 'PROCESSLIST'],
    ['INSERT', 'INTO'], ['KILL', 'QUERY'], ['KILL', 'MUTATION'],
    ['IF', 'NOT', 'EXISTS'], ['IF', 'EXISTS'], ['OR', 'REPLACE'], ['ON', 'CLUSTER'],
    ['IS', 'NOT', 'NULL'], ['IS', 'NULL'], ['NOT', 'NULL'], ['NOT', 'IN'], ['NOT', 'LIKE'],
    ['NOT', 'ILIKE'], ['NOT', 'BETWEEN'], ['NOT', 'EXISTS'],
    ['GLOBAL', 'NOT', 'IN'], ['GLOBAL', 'IN'],
    ['UNION', 'ALL'], ['UNION', 'DISTINCT'],
    ['WITH', 'TOTALS'], ['WITH', 'ROLLUP'], ['WITH', 'CUBE'], ['WITH', 'FILL'], ['WITH', 'TIES'],
    ['NULLS', 'FIRST'], ['NULLS', 'LAST'], ['PRIMARY', 'KEY'],
    ['CURRENT', 'ROW'], ['UNBOUNDED', 'PRECEDING'], ['UNBOUNDED', 'FOLLOWING'],
    ['ROWS', 'BETWEEN'], ['RANGE', 'BETWEEN'], ['GROUPS', 'BETWEEN'],
    ['FROM', 'INFILE'], ['INTO', 'OUTFILE'],
    ['LEFT', 'ARRAY', 'JOIN'], ['ARRAY', 'JOIN'],
];

const PHRASES_BY_HEAD = new Map<string, string[][]>();
for (const phrase of [...PHRASES].sort((a, b) => b.length - a.length)) {
    const list = PHRASES_BY_HEAD.get(phrase[0]) ?? [];
    list.push(phrase);
    PHRASES_BY_HEAD.set(phrase[0], list);
}

/**
 * Keywords that only appear inside DDL. Enabled per-statement so that
 * `SELECT type, comment FROM system.columns` keeps its column names intact.
 */
const DDL_KEYWORDS = new Set([
    'ENGINE', 'CODEC', 'DEFAULT', 'MATERIALIZED', 'ALIAS', 'EPHEMERAL', 'COMMENT',
    'INDEX', 'PROJECTION', 'CONSTRAINT', 'CHECK', 'GRANULARITY', 'TYPE',
    'ADD', 'MODIFY', 'CLEAR', 'COLUMN', 'TABLE', 'DATABASE', 'VIEW', 'DICTIONARY',
    'POPULATE', 'REPLACE', 'TEMPORARY', 'DEDUPLICATE', 'FREEZE', 'FETCH', 'MOVE',
    'LAYOUT', 'SOURCE', 'LIFETIME', 'RANGE', 'STRUCTURE', 'TO', 'DELETE', 'UPDATE',
    'VOLUME', 'DISK', 'RECOMPRESS', 'GROUP',
]);

const TIME_UNITS = new Set([
    'NANOSECOND', 'MICROSECOND', 'MILLISECOND', 'SECOND', 'MINUTE', 'HOUR',
    'DAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR',
    'NANOSECONDS', 'MICROSECONDS', 'MILLISECONDS', 'SECONDS', 'MINUTES', 'HOURS',
    'DAYS', 'WEEKS', 'MONTHS', 'QUARTERS', 'YEARS',
]);

/** Output format names, used to recognise a real `FORMAT` clause. */
const FORMAT_NAMES = new Set([
    'TABSEPARATED', 'TABSEPARATEDRAW', 'TABSEPARATEDWITHNAMES', 'TABSEPARATEDWITHNAMESANDTYPES',
    'TEMPLATE', 'CSV', 'CSVWITHNAMES', 'CSVWITHNAMESANDTYPES', 'CUSTOMSEPARATED',
    'VALUES', 'VERTICAL', 'JSON', 'JSONASSTRING', 'JSONSTRINGS', 'JSONCOMPACT',
    'JSONCOMPACTSTRINGS', 'JSONEACHROW', 'JSONSTRINGSEACHROW', 'JSONCOMPACTEACHROW',
    'JSONCOMPACTEACHROWWITHNAMES', 'JSONCOMPACTEACHROWWITHNAMESANDTYPES', 'JSONOBJECTEACHROW',
    'BSONEACHROW', 'TSKV', 'PRETTY', 'PRETTYCOMPACT', 'PRETTYCOMPACTMONOBLOCK',
    'PRETTYNOESCAPES', 'PRETTYSPACE', 'PROTOBUF', 'PROTOBUFSINGLE', 'AVRO', 'AVROCONFLUENT',
    'PARQUET', 'ARROW', 'ARROWSTREAM', 'ORC', 'ONE', 'ROWBINARY', 'ROWBINARYWITHNAMES',
    'ROWBINARYWITHNAMESANDTYPES', 'NATIVE', 'NULL', 'XML', 'CAPNPROTO', 'LINEASSTRING',
    'REGEXP', 'RAWBLOB', 'MSGPACK', 'MARKDOWN',
]);

export type KeywordCase = 'upper' | 'lower' | 'preserve';

/** Statement kind, derived from the leading significant word. */
export function statementKind(upper: string): 'select' | 'insert' | 'ddl' | 'system' | 'other' {
    if (upper === 'SELECT' || upper === 'WITH') return 'select';
    if (upper === 'INSERT') return 'insert';
    if (['CREATE', 'ALTER', 'DROP', 'ATTACH', 'DETACH', 'RENAME', 'TRUNCATE', 'OPTIMIZE', 'EXCHANGE'].includes(upper)) {
        return 'ddl';
    }
    if (['SYSTEM', 'KILL', 'SET', 'USE', 'GRANT', 'REVOKE'].includes(upper)) return 'system';
    return 'other';
}

interface CaseState {
    /** Depth of open CASE expressions, so a trailing END is recognised. */
    caseDepth: number;
    /** Significant-token index of the last cased INTERVAL, for its time unit. */
    intervalAt: number;
    ddl: boolean;
    statementStart: number;
}

/**
 * Decide whether a word token is being used as a keyword.
 *
 * `sig` holds indices of non-trivia tokens; `j` is the position within `sig`.
 * Returns the number of significant tokens the keyword spans (0 when the word is
 * not a keyword here), so phrases are consumed as a unit.
 */
function classify(tokens: Token[], sig: number[], j: number, state: CaseState): number {
    const tok = tokens[sig[j]];
    const upper = tok.upper;

    const prev = j > 0 ? tokens[sig[j - 1]] : undefined;
    const next = j + 1 < sig.length ? tokens[sig[j + 1]] : undefined;

    // A qualified name part is never a keyword: system.tables, t.range.
    // Adjacency matters: in a half-typed `SELECT e. FROM t` the `FROM` is still
    // a clause keyword, because the dangling dot is not attached to it.
    if (prev && prev.kind === TokenKind.Punct && prev.text === '.' && prev.end === tok.start) return 0;
    // A qualifier is never a keyword either: system.parts, left.id
    if (next && next.kind === TokenKind.Punct && next.text === '.' && tok.end === next.start) return 0;

    // SYSTEM heads a statement (SYSTEM RELOAD …); elsewhere it is the database name.
    if (upper === 'SYSTEM') return j === state.statementStart ? 1 : 0;

    // Longest matching phrase wins.
    const phrases = PHRASES_BY_HEAD.get(upper);
    if (phrases) {
        for (const phrase of phrases) {
            let ok = true;
            for (let k = 0; k < phrase.length; k++) {
                const t = j + k < sig.length ? tokens[sig[j + k]] : undefined;
                if (!t || t.kind !== TokenKind.Word || t.upper !== phrase[k]) {
                    ok = false;
                    break;
                }
            }
            if (ok) return phrase.length;
        }
    }

    // JOIN plus however many modifiers precede it.
    if (upper === 'JOIN') return 1;
    if (JOIN_MODIFIERS.has(upper)) {
        let k = j + 1;
        while (k < sig.length) {
            const t = tokens[sig[k]];
            if (t.kind !== TokenKind.Word) return 0;
            if (t.upper === 'JOIN') return 1;
            if (!JOIN_MODIFIERS.has(t.upper)) return 0;
            k++;
        }
        return 0;
    }

    // GROUP BY / ORDER BY / PARTITION BY / SAMPLE BY / LIMIT BY
    if (upper === 'BY') return prev && prev.kind === TokenKind.Word && BY_HEADS.has(prev.upper) ? 1 : 0;
    if (BY_HEADS.has(upper) && next && next.kind === TokenKind.Word && next.upper === 'BY') return 1;

    // END only closes a CASE.
    if (upper === 'END') return state.caseDepth > 0 ? 1 : 0;

    // Window frame bounds.
    if (upper === 'PRECEDING' || upper === 'FOLLOWING') {
        return prev && (prev.kind === TokenKind.Number || (prev.kind === TokenKind.Word && prev.upper === 'UNBOUNDED')) ? 1 : 0;
    }

    // INTERVAL 3 DAY — the unit is a keyword only right after an interval literal.
    if (TIME_UNITS.has(upper) && state.intervalAt >= 0 && j - state.intervalAt <= 2) return 1;
    if (upper === 'INTERVAL') return next && next.kind === TokenKind.Number ? 1 : 0;

    // FORMAT is a clause when a real format name follows it — or when nothing
    // does yet, which is what a half-typed `… FORMAT ` looks like.
    if (upper === 'FORMAT') {
        if (!next) return 1;
        if (next.kind === TokenKind.Punct && next.text === ';') return 1;
        return next.kind === TokenKind.Word && FORMAT_NAMES.has(next.upper) ? 1 : 0;
    }

    // SAMPLE 0.1 / SAMPLE 1/10
    if (upper === 'SAMPLE') return next && next.kind === TokenKind.Number ? 1 : 0;

    // SET is a keyword after UPDATE, or as the first word of a statement.
    if (upper === 'SET') {
        if (j === state.statementStart) return 1;
        return prev && prev.kind === TokenKind.Word && prev.upper === 'UPDATE' ? 1 : 0;
    }

    // ENGINE = MergeTree
    if (upper === 'ENGINE') {
        return next && next.kind === TokenKind.Operator && next.text === '=' ? 1 : 0;
    }

    if (state.ddl && DDL_KEYWORDS.has(upper)) {
        return isFunctionCall(upper, next) ? 0 : 1;
    }

    if (RESERVED.has(upper)) {
        return isFunctionCall(upper, next) ? 0 : 1;
    }

    return 0;
}

/**
 * Mark which word tokens are used as keywords.
 * Returns a Set of token indices.
 */
export function findKeywordTokens(tokens: Token[]): Set<number> {
    const keywords = new Set<number>();
    const sig: number[] = [];
    for (let i = 0; i < tokens.length; i++) {
        if (tokens[i].kind !== TokenKind.Whitespace && tokens[i].kind !== TokenKind.LineComment && tokens[i].kind !== TokenKind.BlockComment) {
            sig.push(i);
        }
    }

    const state: CaseState = { caseDepth: 0, intervalAt: -1, ddl: false, statementStart: 0 };

    // Statement boundaries decide which contextual keyword sets are live.
    const startStatement = (j: number) => {
        state.statementStart = j;
        state.caseDepth = 0;
        state.intervalAt = -1;
        const first = j < sig.length ? tokens[sig[j]] : undefined;
        const kind = first && first.kind === TokenKind.Word ? statementKind(first.upper) : 'other';
        state.ddl = kind === 'ddl';
    };
    startStatement(0);

    let j = 0;
    while (j < sig.length) {
        const tok = tokens[sig[j]];

        if (tok.kind === TokenKind.Punct && tok.text === ';') {
            startStatement(j + 1);
            j++;
            continue;
        }

        if (tok.kind !== TokenKind.Word) {
            j++;
            continue;
        }

        const span = classify(tokens, sig, j, state);
        if (span > 0) {
            for (let k = 0; k < span; k++) keywords.add(sig[j + k]);
            const upper = tok.upper;
            if (upper === 'CASE') state.caseDepth++;
            else if (upper === 'END' && state.caseDepth > 0) state.caseDepth--;
            else if (upper === 'INTERVAL') state.intervalAt = j;
            j += span;
            continue;
        }

        j++;
    }

    return keywords;
}

/** Apply `keywordCase` to the keyword tokens in place. */
export function applyKeywordCase(tokens: Token[], keywordCase: KeywordCase): void {
    if (keywordCase === 'preserve') return;
    const keywords = findKeywordTokens(tokens);
    for (const index of keywords) {
        const tok = tokens[index];
        tok.text = keywordCase === 'upper' ? tok.upper : tok.text.toLowerCase();
    }
}
