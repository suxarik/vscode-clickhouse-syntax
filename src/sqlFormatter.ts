/**
 * SQL formatter for ClickHouse queries.
 *
 * Works over the token stream from `lexer.ts` rather than over raw text, which
 * is what lets it case keywords without touching identifiers, and lets it
 * descend into subqueries, CTE bodies and DDL column lists.
 */
import { Token, TokenKind, tokenize, isTrivia } from './lexer';
import { applyKeywordCase, findKeywordTokens, statementKind, KeywordCase, TIGHT_PAREN } from './keywords';

export interface FormatOptions {
    keywordCase: KeywordCase;
    indentSize: number;
}

type StatementKind = ReturnType<typeof statementKind>;

interface TokenNode {
    type: 'token';
    token: Token;
    /** True when the token is used as a keyword (not an identifier). */
    keyword: boolean;
    /** True when a line break separated this node from the previous one. */
    onNewLine: boolean;
}

interface GroupNode {
    type: 'group';
    open: Token;
    close: Token | null;
    items: Node[];
    onNewLine: boolean;
}

type Node = TokenNode | GroupNode;

type BodyStyle = 'list' | 'condition' | 'conditionInline' | 'inline' | 'none';

interface ClauseSpec {
    words: string[];
    style: BodyStyle;
    /** Restrict the clause to particular statement kinds. */
    only?: StatementKind[];
}

const CLAUSES: ClauseSpec[] = [
    // DDL-scoped clauses come first: inside CREATE/ALTER, `ORDER BY (a, b)` is a
    // table property that belongs on one line, not a projected column list.
    { words: ['ENGINE'], style: 'inline', only: ['ddl'] },
    { words: ['PARTITION', 'BY'], style: 'inline', only: ['ddl'] },
    { words: ['PRIMARY', 'KEY'], style: 'inline', only: ['ddl'] },
    { words: ['SAMPLE', 'BY'], style: 'inline', only: ['ddl'] },
    { words: ['ORDER', 'BY'], style: 'inline', only: ['ddl'] },
    { words: ['TTL'], style: 'inline', only: ['ddl'] },
    { words: ['COMMENT'], style: 'inline', only: ['ddl'] },
    { words: ['POPULATE'], style: 'none', only: ['ddl'] },
    { words: ['SOURCE'], style: 'inline', only: ['ddl'] },
    { words: ['LAYOUT'], style: 'inline', only: ['ddl'] },
    { words: ['LIFETIME'], style: 'inline', only: ['ddl'] },
    { words: ['AS'], style: 'none', only: ['ddl'] },
    { words: ['TO'], style: 'none', only: ['ddl'] },
    { words: ['VALUES'], style: 'list', only: ['insert'] },

    { words: ['SELECT', 'DISTINCT'], style: 'list' },
    { words: ['SELECT'], style: 'list' },
    { words: ['FROM', 'INFILE'], style: 'inline' },
    { words: ['FROM'], style: 'inline' },
    { words: ['PREWHERE'], style: 'condition' },
    { words: ['WHERE'], style: 'condition' },
    { words: ['GROUP', 'BY'], style: 'list' },
    { words: ['HAVING'], style: 'condition' },
    { words: ['QUALIFY'], style: 'condition' },
    { words: ['WINDOW'], style: 'list' },
    { words: ['ORDER', 'BY'], style: 'list' },
    { words: ['LIMIT'], style: 'inline' },
    { words: ['OFFSET'], style: 'inline' },
    { words: ['INTO', 'OUTFILE'], style: 'inline' },
    { words: ['SETTINGS'], style: 'inline' },
    { words: ['FORMAT'], style: 'inline' },
    { words: ['UNION', 'ALL'], style: 'none' },
    { words: ['UNION', 'DISTINCT'], style: 'none' },
    { words: ['UNION'], style: 'none' },
    { words: ['INTERSECT'], style: 'none' },
    { words: ['EXCEPT'], style: 'none' },
    { words: ['ON'], style: 'conditionInline' },
    { words: ['USING'], style: 'inline' },
];


const CLAUSES_BY_HEAD = new Map<string, ClauseSpec[]>();
for (const spec of CLAUSES) {
    const list = CLAUSES_BY_HEAD.get(spec.words[0]) ?? [];
    list.push(spec);
    CLAUSES_BY_HEAD.set(spec.words[0], list);
}
for (const list of CLAUSES_BY_HEAD.values()) {
    // Longest phrase first, but a DDL-scoped spec always outranks a generic one
    // of the same length because it was declared first.
    list.sort((a, b) => b.words.length - a.words.length);
}

const JOIN_MODIFIERS = new Set([
    'GLOBAL', 'LEFT', 'RIGHT', 'FULL', 'INNER', 'CROSS', 'OUTER',
    'ANY', 'ALL', 'SEMI', 'ANTI', 'ASOF', 'ARRAY', 'PASTE',
]);

/** `WITH` heads a CTE list, but `WITH TOTALS`/`ROLLUP`/`CUBE`/`FILL` are modifiers. */
const WITH_MODIFIERS = new Set(['TOTALS', 'ROLLUP', 'CUBE', 'FILL', 'TIES']);

/** Statement heads whose first parenthesised group is a column definition list. */
const COLUMN_LIST_HEADS = [
    ['CREATE', 'TABLE'], ['CREATE', 'TEMPORARY', 'TABLE'], ['ATTACH', 'TABLE'],
    ['CREATE', 'DICTIONARY'], ['CREATE', 'OR', 'REPLACE', 'TABLE'],
];

// ── Node tree ────────────────────────────────────────────────────────────────

function buildNodes(tokens: Token[], keywords: Set<number>): Node[] {
    const root: Node[] = [];
    const stack: Node[][] = [root];
    const openStack: Token[] = [];
    let sawNewline = false;

    for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i];

        if (tok.kind === TokenKind.Whitespace) {
            if (tok.text.includes('\n')) sawNewline = true;
            continue;
        }

        const current = stack[stack.length - 1];

        if (tok.kind === TokenKind.Punct && (tok.text === '(' || tok.text === '[')) {
            const group: GroupNode = { type: 'group', open: tok, close: null, items: [], onNewLine: sawNewline };
            current.push(group);
            stack.push(group.items);
            openStack.push(tok);
            sawNewline = false;
            continue;
        }

        if (
            tok.kind === TokenKind.Punct &&
            (tok.text === ')' || tok.text === ']') &&
            stack.length > 1 &&
            openStack[openStack.length - 1].text === (tok.text === ')' ? '(' : '[')
        ) {
            stack.pop();
            openStack.pop();
            const parent = stack[stack.length - 1];
            const group = parent[parent.length - 1] as GroupNode;
            group.close = tok;
            sawNewline = false;
            continue;
        }

        current.push({ type: 'token', token: tok, keyword: keywords.has(i), onNewLine: sawNewline });
        sawNewline = false;
    }

    return root;
}

function isWord(node: Node | undefined, upper?: string): node is TokenNode {
    if (!node || node.type !== 'token' || node.token.kind !== TokenKind.Word) return false;
    return upper === undefined || node.token.upper === upper;
}

function isPunct(node: Node | undefined, text: string): boolean {
    return !!node && node.type === 'token' && node.token.kind === TokenKind.Punct && node.token.text === text;
}

function isLineComment(node: Node | undefined): boolean {
    return !!node && node.type === 'token' && node.token.kind === TokenKind.LineComment;
}

/** True when the node list contains a SELECT/WITH at its own level — i.e. a subquery. */
function containsSubquery(items: Node[]): boolean {
    for (const item of items) {
        if (item.type !== 'token') continue;
        if (!item.keyword) continue;
        if (item.token.upper === 'SELECT' || item.token.upper === 'WITH' || item.token.upper === 'VALUES') return true;
    }
    return false;
}

function containsLineComment(items: Node[]): boolean {
    for (const item of items) {
        if (item.type === 'token') {
            if (item.token.kind === TokenKind.LineComment) return true;
        } else if (containsLineComment(item.items)) {
            return true;
        }
    }
    return false;
}

// ── Spacing ──────────────────────────────────────────────────────────────────

interface PrevInfo {
    token: Token;
    keyword: boolean;
    unaryOperator: boolean;
}

function needsSpaceBefore(prev: PrevInfo | null, next: Token, nextIsGroupOpen: boolean): boolean {
    if (!prev) return false;
    if (prev.unaryOperator) return false;

    const p = prev.token;

    if (p.kind === TokenKind.Punct && (p.text === '(' || p.text === '[' || p.text === '.')) return false;
    if (p.kind === TokenKind.Operator && p.text === '::') return false;

    if (next.kind === TokenKind.Punct) {
        const t = next.text;
        if (t === ',' || t === ';' || t === ')' || t === ']' || t === '.') return false;
        if (t === '(') {
            // Function call: `count(`, `toDate(`. Keyword before a paren keeps its space.
            if (p.kind === TokenKind.Word && !prev.keyword) return false;
            if (p.kind === TokenKind.Word && prev.keyword && TIGHT_PAREN.has(p.upper)) return false;
            if (p.kind === TokenKind.BacktickIdent || p.kind === TokenKind.QuotedIdent) return false;
            if (p.kind === TokenKind.Punct && p.text === ')') return false; // topK(3)(x)
            return true;
        }
        if (t === '[') {
            // Subscript vs array literal.
            if (p.kind === TokenKind.Word && !prev.keyword) return false;
            if (p.kind === TokenKind.BacktickIdent || p.kind === TokenKind.QuotedIdent) return false;
            if (p.kind === TokenKind.Punct && (p.text === ')' || p.text === ']')) return false;
            return true;
        }
    }
    if (nextIsGroupOpen) {
        if (p.kind === TokenKind.Word && !prev.keyword) return false;
        if (p.kind === TokenKind.Word && prev.keyword && TIGHT_PAREN.has(p.upper)) return false;
        if (p.kind === TokenKind.BacktickIdent || p.kind === TokenKind.QuotedIdent) return false;
        if (p.kind === TokenKind.Punct && p.text === ')') return false;
        return true;
    }

    if (next.kind === TokenKind.Operator && next.text === '::') return false;

    return true;
}

/** A `-`/`+` is unary when nothing value-like precedes it. */
function isUnaryOperator(token: Token, prev: PrevInfo | null): boolean {
    if (token.kind !== TokenKind.Operator) return false;
    if (token.text !== '-' && token.text !== '+') return false;
    if (!prev) return true;
    const p = prev.token;
    if (p.kind === TokenKind.Operator) return true;
    if (p.kind === TokenKind.Punct && ['(', '[', ',', ';'].includes(p.text)) return true;
    if (p.kind === TokenKind.Word && prev.keyword) return true;
    return false;
}

// ── Emitter ──────────────────────────────────────────────────────────────────

class Emitter {
    private parts: string[] = [];
    private pendingIndent: number | null = null;
    private lineEmpty = true;
    private started = false;

    constructor(private readonly unit: string) {}

    breakLine(indent: number): void {
        this.pendingIndent = indent;
    }

    write(text: string): void {
        if (this.pendingIndent !== null) {
            if (this.started) this.parts.push('\n');
            this.parts.push(this.unit.repeat(this.pendingIndent));
            this.pendingIndent = null;
            this.lineEmpty = false;
            this.started = true;
        }
        this.started = true;
        this.lineEmpty = false;
        this.parts.push(text);
    }

    space(): void {
        if (this.pendingIndent !== null || this.lineEmpty || !this.started) return;
        const last = this.parts[this.parts.length - 1];
        if (last === undefined || last.endsWith(' ')) return;
        this.parts.push(' ');
    }

    toString(): string {
        return this.parts
            .join('')
            .split('\n')
            .map(l => l.replace(/\s+$/, ''))
            .join('\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }
}

// ── Printer ──────────────────────────────────────────────────────────────────

interface PrintContext {
    stmtKind: StatementKind;
    /** Cleared once the DDL column-definition list has been consumed. */
    columnListPending: boolean;
    /** Cleared once the INSERT column list has been consumed. */
    insertColumnsPending: boolean;
}

class Printer {
    private prev: PrevInfo | null = null;

    constructor(private readonly emitter: Emitter, private readonly ctx: PrintContext) {}

    private writeToken(node: TokenNode): void {
        const token = node.token;
        const unary = isUnaryOperator(token, this.prev);
        if (needsSpaceBefore(this.prev, token, false)) this.emitter.space();
        this.emitter.write(token.text);
        this.prev = { token, keyword: node.keyword, unaryOperator: unary };
    }

    private writeRaw(text: string, token: Token, keyword = false): void {
        this.emitter.write(text);
        this.prev = { token, keyword, unaryOperator: false };
    }

    private breakLine(indent: number): void {
        this.emitter.breakLine(indent);
        this.prev = null;
    }

    /**
     * Match a clause starting at `i`. Returns the matched spec and the number of
     * nodes it spans, handling join runs and CTE-heading WITH specially.
     */
    private matchClause(nodes: Node[], i: number): { words: string[]; style: BodyStyle; span: number } | null {
        const node = nodes[i];
        if (node.type !== 'token' || !node.keyword || node.token.kind !== TokenKind.Word) return null;
        const upper = node.token.upper;

        // JOIN, with any run of modifiers in front of it.
        if (upper === 'JOIN' || JOIN_MODIFIERS.has(upper)) {
            let end = i;
            while (end < nodes.length) {
                const n = nodes[end];
                if (!isWord(n) || !(n as TokenNode).keyword) break;
                const u = n.token.upper;
                if (u === 'JOIN') {
                    const words: string[] = [];
                    for (let k = i; k <= end; k++) words.push((nodes[k] as TokenNode).token.text);
                    return { words, style: 'inline', span: end - i + 1 };
                }
                if (!JOIN_MODIFIERS.has(u)) break;
                end++;
            }
            if (upper !== 'JOIN') return null;
        }

        if (upper === 'WITH') {
            const next = nodes[i + 1];
            if (isWord(next) && WITH_MODIFIERS.has(next.token.upper)) return null;
            return { words: [node.token.text], style: 'list', span: 1 };
        }

        const specs = CLAUSES_BY_HEAD.get(upper);
        if (!specs) return null;

        for (const spec of specs) {
            if (spec.only && !spec.only.includes(this.ctx.stmtKind)) continue;
            let ok = true;
            const words: string[] = [];
            for (let k = 0; k < spec.words.length; k++) {
                const n = nodes[i + k];
                if (!isWord(n) || !(n as TokenNode).keyword || n.token.upper !== spec.words[k]) {
                    ok = false;
                    break;
                }
                words.push(n.token.text);
            }
            if (ok) return { words, style: spec.style, span: spec.words.length };
        }
        return null;
    }

    private renderInline(nodes: Node[]): string {
        const emitter = new Emitter('');
        const printer = new Printer(emitter, this.ctx);
        printer.prev = null;
        for (const node of nodes) {
            if (node.type === 'group') {
                printer.writeGroupInline(node);
            } else {
                printer.writeToken(node);
            }
        }
        return emitter.toString();
    }

    private writeGroupInline(group: GroupNode, forceSpace = false): void {
        if (forceSpace || needsSpaceBefore(this.prev, group.open, true)) this.emitter.space();
        this.emitter.write(group.open.text);
        this.prev = { token: group.open, keyword: false, unaryOperator: false };
        for (const item of group.items) {
            if (item.type === 'group') this.writeGroupInline(item);
            else this.writeToken(item);
        }
        if (group.close) {
            this.emitter.write(group.close.text);
            this.prev = { token: group.close, keyword: false, unaryOperator: false };
        }
    }

    private writeGroupBlock(group: GroupNode, indent: number, style: 'subquery' | 'list'): void {
        if (style === 'list') {
            // SHOW CREATE TABLE style: the definition list opens on its own line.
            this.breakLine(indent);
        } else if (needsSpaceBefore(this.prev, group.open, true)) {
            this.emitter.space();
        }
        this.emitter.write(group.open.text);
        this.prev = { token: group.open, keyword: false, unaryOperator: false };

        const inner = new Printer(this.emitter, { ...this.ctx, columnListPending: false, insertColumnsPending: false });
        this.emitter.breakLine(indent + 1);
        inner.prev = null;
        if (style === 'list') {
            inner.printList(group.items, indent + 1);
        } else {
            inner.printNodes(group.items, indent + 1, 'none');
        }

        this.breakLine(indent);
        if (group.close) {
            this.emitter.write(group.close.text);
            this.prev = { token: group.close, keyword: false, unaryOperator: false };
        }
    }

    /** One comma-separated item per line, at `indent`. */
    printList(nodes: Node[], indent: number): void {
        let pendingBreak = false;
        for (let i = 0; i < nodes.length; i++) {
            const node = nodes[i];

            if (pendingBreak) {
                if (isLineComment(node) && !node.onNewLine) {
                    this.emitter.space();
                    this.emitter.write((node as TokenNode).token.text);
                    this.prev = null;
                } else {
                    this.breakLine(indent);
                }
                pendingBreak = false;
                if (isLineComment(node) && !(node as TokenNode).onNewLine) {
                    this.breakLine(indent);
                    continue;
                }
            }

            if (node.type === 'token' && isPunct(node, ',')) {
                this.writeToken(node);
                pendingBreak = true;
                continue;
            }

            this.writeNode(node, indent);
        }
    }

    private writeNode(node: Node, indent: number): void {
        if (node.type === 'group') {
            if (node.open.text === '[') {
                this.writeGroupInline(node);
                return;
            }
            const hasSub = containsSubquery(node.items);
            const forceBlock = hasSub || containsLineComment(node.items);
            if (forceBlock && node.items.length > 0) {
                this.writeGroupBlock(node, indent, 'subquery');
            } else {
                this.writeGroupInline(node);
            }
            return;
        }

        if (node.token.kind === TokenKind.LineComment) {
            if (node.onNewLine) this.breakLine(indent);
            else this.emitter.space();
            this.emitter.write(node.token.text);
            this.breakLine(indent);
            return;
        }

        this.writeToken(node);
    }

    /**
     * Print a node list at `indent`, breaking before clause heads.
     * `style` controls how commas and AND/OR inside the current clause body break.
     */
    printNodes(nodes: Node[], indent: number, style: BodyStyle): void {
        let bodyStyle: BodyStyle = style;
        let bodyIndent = indent;
        let pendingBreak: number | null = null;

        const flushPending = (node: Node): boolean => {
            if (pendingBreak === null) return false;
            if (isLineComment(node) && !node.onNewLine) {
                this.emitter.space();
                this.emitter.write((node as TokenNode).token.text);
                this.breakLine(pendingBreak);
                pendingBreak = null;
                return true;
            }
            this.breakLine(pendingBreak);
            pendingBreak = null;
            return false;
        };

        for (let i = 0; i < nodes.length; i++) {
            const node = nodes[i];

            if (flushPending(node)) continue;

            const clause = node.type === 'token' ? this.matchClause(nodes, i) : null;
            if (clause) {
                const joinCondition = clause.style === 'conditionInline';
                this.breakLine(joinCondition ? indent + 1 : indent);
                this.writeRaw(clause.words.join(' '), (node as TokenNode).token, true);
                i += clause.span - 1;

                bodyStyle = clause.style;
                if (clause.style === 'list' || clause.style === 'condition') {
                    bodyIndent = indent + 1;
                    pendingBreak = bodyIndent;
                } else if (joinCondition) {
                    bodyIndent = indent + 1;
                } else {
                    bodyIndent = indent;
                }
                continue;
            }

            if (node.type === 'token' && isPunct(node, ',') && bodyStyle === 'list') {
                this.writeToken(node);
                pendingBreak = bodyIndent;
                continue;
            }

            if (
                (bodyStyle === 'condition' || bodyStyle === 'conditionInline') &&
                node.type === 'token' &&
                node.keyword &&
                (node.token.upper === 'AND' || node.token.upper === 'OR')
            ) {
                this.breakLine(bodyIndent);
                this.writeToken(node);
                continue;
            }

            if (node.type === 'group' && node.open.text === '(') {
                if (this.ctx.columnListPending) {
                    this.ctx.columnListPending = false;
                    if (node.items.length > 0) {
                        this.writeGroupBlock(node, indent, 'list');
                        continue;
                    }
                }
                if (this.ctx.insertColumnsPending) {
                    this.ctx.insertColumnsPending = false;
                    this.writeGroupInline(node, true);
                    continue;
                }
                this.writeNode(node, bodyIndent);
                continue;
            }

            this.writeNode(node, bodyIndent);
        }
    }

}

// ── Entry point ──────────────────────────────────────────────────────────────

function splitStatements(nodes: Node[]): Node[][] {
    const statements: Node[][] = [];
    let current: Node[] = [];
    for (const node of nodes) {
        current.push(node);
        if (node.type === 'token' && isPunct(node, ';')) {
            statements.push(current);
            current = [];
        }
    }
    if (current.length > 0) statements.push(current);
    return statements;
}

function statementKindOf(nodes: Node[]): StatementKind {
    for (const node of nodes) {
        if (node.type === 'token' && node.token.kind === TokenKind.Word) {
            return statementKind(node.token.upper);
        }
        if (node.type === 'group') break;
    }
    return 'other';
}

function startsColumnList(nodes: Node[]): boolean {
    const words: string[] = [];
    for (const node of nodes) {
        if (node.type !== 'token') break;
        if (isTrivia(node.token)) continue;
        if (node.token.kind !== TokenKind.Word) break;
        words.push(node.token.upper);
        if (words.length >= 4) break;
    }
    return COLUMN_LIST_HEADS.some(head => head.every((w, idx) => words[idx] === w));
}

export function formatSQLWithOptions(text: string, options: FormatOptions): string {
    if (!text || !text.trim()) return text;

    const indentSize = Number.isFinite(options.indentSize) && options.indentSize > 0 ? options.indentSize : 4;
    const unit = ' '.repeat(indentSize);

    const tokens = tokenize(text);
    const keywords = findKeywordTokens(tokens);
    applyKeywordCase(tokens, options.keywordCase);

    const nodes = buildNodes(tokens, keywords);
    const statements = splitStatements(nodes);

    const rendered: string[] = [];
    for (const statement of statements) {
        if (statement.length === 0) continue;
        const emitter = new Emitter(unit);
        const kind = statementKindOf(statement);
        const ctx: PrintContext = {
            stmtKind: kind,
            columnListPending: startsColumnList(statement),
            insertColumnsPending: kind === 'insert',
        };
        const printer = new Printer(emitter, ctx);
        printer.printNodes(statement, 0, 'none');
        const out = emitter.toString();
        if (out.length > 0) rendered.push(out);
    }

    return rendered.join('\n\n');
}

/**
 * Backwards-compatible entry point.
 */
export function formatSQL(text: string, keywordCase: string, indentSize: number): string {
    const mode: KeywordCase =
        keywordCase === 'lower' ? 'lower' : keywordCase === 'preserve' ? 'preserve' : 'upper';
    return formatSQLWithOptions(text, { keywordCase: mode, indentSize });
}
