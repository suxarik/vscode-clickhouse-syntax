/**
 * Error-tolerant recursive-descent parser for ClickHouse SQL.
 *
 * The parser never throws and never stops early: unparseable regions become
 * `ErrorExpression` nodes and parsing resumes at the next clause or statement
 * boundary. That matters because the editor asks for a tree on every keystroke,
 * when the query is usually half-written.
 */
import { Token, TokenKind, tokenize, isTrivia } from '../lexer';
import { findKeywordTokens } from '../keywords';
import {
    AlterTableStatement,
    ArrayJoinClause,
    ColumnDefinition,
    CreateTableStatement,
    CreateViewStatement,
    Cte,
    DropStatement,
    Expression,
    FromClause,
    FunctionCall,
    Identifier,
    InsertStatement,
    Join,
    NameExpression,
    OrderByItem,
    ParseDiagnostic,
    ParseResult,
    SelectItem,
    SelectStatement,
    SettingAssignment,
    Statement,
    TableRef,
    TableSource,
    WindowDefinition,
} from './ast';

/** Binary operator precedence; higher binds tighter. */
const BINARY_PRECEDENCE: Record<string, number> = {
    OR: 1,
    AND: 2,
    '=': 4, '==': 4, '!=': 4, '<>': 4, '<': 4, '<=': 4, '>': 4, '>=': 4, '<=>': 4,
    IN: 4, LIKE: 4, ILIKE: 4, IS: 4, BETWEEN: 4,
    '||': 5,
    '+': 6, '-': 6,
    '*': 7, '/': 7, '%': 7,
};

/** Keywords that end an expression and start something else. */
const EXPRESSION_STOP = new Set([
    'FROM', 'WHERE', 'PREWHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET',
    'SETTINGS', 'FORMAT', 'UNION', 'INTERSECT', 'EXCEPT', 'INTO', 'VALUES',
    'QUALIFY', 'WINDOW', 'JOIN', 'ON', 'USING', 'WITH', 'SELECT', 'ARRAY',
    'LEFT', 'RIGHT', 'FULL', 'INNER', 'CROSS', 'ASOF', 'ANTI', 'SEMI', 'PASTE',
    'THEN', 'ELSE', 'END', 'WHEN', 'ENGINE', 'PARTITION', 'PRIMARY', 'SAMPLE',
    'TTL', 'AS', 'ASC', 'DESC', 'NULLS', 'BY', 'GLOBAL', 'ANY', 'ALL',
]);

/** Keywords that begin a new clause, so an item list must stop before them. */
const CLAUSE_BOUNDARY = new Set([
    'FROM', 'PREWHERE', 'WHERE', 'GROUP', 'HAVING', 'WINDOW', 'QUALIFY', 'ORDER',
    'LIMIT', 'OFFSET', 'SETTINGS', 'FORMAT', 'UNION', 'INTERSECT', 'EXCEPT',
    'INTO', 'ON', 'USING', 'JOIN', 'VALUES', 'ENGINE', 'PARTITION', 'PRIMARY',
    'SAMPLE', 'TTL', 'ARRAY',
]);

const JOIN_MODIFIERS = new Set([
    'GLOBAL', 'LEFT', 'RIGHT', 'FULL', 'INNER', 'CROSS', 'OUTER',
    'ANY', 'ALL', 'SEMI', 'ANTI', 'ASOF', 'PASTE',
]);

/** Words that end a column type in a CREATE TABLE definition. */
const COLUMN_MODIFIERS = new Set([
    'DEFAULT', 'MATERIALIZED', 'ALIAS', 'EPHEMERAL', 'CODEC', 'TTL', 'COMMENT',
    'NOT', 'NULL', 'PRIMARY', 'AUTO_INCREMENT', 'SETTINGS',
]);

const TIME_UNITS = new Set([
    'NANOSECOND', 'MICROSECOND', 'MILLISECOND', 'SECOND', 'MINUTE', 'HOUR',
    'DAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR',
]);

class Parser {
    private readonly tokens: Token[];
    private readonly sig: number[];
    private readonly keywords: Set<number>;
    private readonly diagnostics: ParseDiagnostic[] = [];
    private pos = 0;
    /** Guards against a rule that fails to consume anything. */
    private guard = 0;

    constructor(private readonly text: string) {
        this.tokens = tokenize(text);
        this.keywords = findKeywordTokens(this.tokens);
        this.sig = [];
        for (let i = 0; i < this.tokens.length; i++) {
            if (!isTrivia(this.tokens[i])) this.sig.push(i);
        }
    }

    // ── Token access ─────────────────────────────────────────────────────────

    private peek(offset = 0): Token | undefined {
        const index = this.sig[this.pos + offset];
        return index === undefined ? undefined : this.tokens[index];
    }

    private isKeyword(offset = 0, upper?: string): boolean {
        const index = this.sig[this.pos + offset];
        if (index === undefined) return false;
        const token = this.tokens[index];
        if (token.kind !== TokenKind.Word || !this.keywords.has(index)) return false;
        return upper === undefined || token.upper === upper;
    }

    private at(upper: string): boolean {
        return this.isKeyword(0, upper);
    }

    private atAny(...uppers: string[]): boolean {
        return uppers.some(upper => this.isKeyword(0, upper));
    }

    private atSequence(...uppers: string[]): boolean {
        return uppers.every((upper, i) => this.isKeyword(i, upper));
    }

    private atPunct(text: string, offset = 0): boolean {
        const token = this.peek(offset);
        return !!token && token.kind === TokenKind.Punct && token.text === text;
    }

    private atOperator(text: string, offset = 0): boolean {
        const token = this.peek(offset);
        return !!token && token.kind === TokenKind.Operator && token.text === text;
    }

    private get done(): boolean {
        return this.pos >= this.sig.length;
    }

    private advance(): Token | undefined {
        const token = this.peek();
        this.pos++;
        return token;
    }

    private eat(upper: string): boolean {
        if (!this.at(upper)) return false;
        this.pos++;
        return true;
    }

    private eatSequence(...uppers: string[]): boolean {
        if (!this.atSequence(...uppers)) return false;
        this.pos += uppers.length;
        return true;
    }

    private eatPunct(text: string): boolean {
        if (!this.atPunct(text)) return false;
        this.pos++;
        return true;
    }

    private error(message: string, token = this.peek()): void {
        const start = token?.start ?? this.text.length;
        const end = token?.end ?? this.text.length;
        // One diagnostic per position is plenty; cascades help nobody.
        if (this.diagnostics.some(d => d.start === start)) return;
        this.diagnostics.push({ start, end, message });
    }

    private expectPunct(text: string): void {
        if (this.eatPunct(text)) return;
        this.error(`Expected '${text}'`);
    }

    /** Offset just past the previous significant token. */
    private get lastEnd(): number {
        const index = this.sig[this.pos - 1];
        return index === undefined ? 0 : this.tokens[index].end;
    }

    private get here(): number {
        return this.peek()?.start ?? this.text.length;
    }

    /** True at a keyword that starts the next clause. */
    private atClauseBoundary(): boolean {
        if (!this.isKeyword()) return false;
        const upper = this.peek()!.upper;
        if (!CLAUSE_BOUNDARY.has(upper)) return false;
        // `LEFT ARRAY JOIN` etc. only bind as a clause after a FROM source.
        return true;
    }

    // ── Names ────────────────────────────────────────────────────────────────

    private atName(): boolean {
        const token = this.peek();
        if (!token) return false;
        if (token.kind === TokenKind.BacktickIdent || token.kind === TokenKind.QuotedIdent) return true;
        return token.kind === TokenKind.Word && !this.isKeyword();
    }

    private parseIdentifier(): Identifier | undefined {
        const token = this.peek();
        if (!token) return undefined;
        if (token.kind === TokenKind.BacktickIdent || token.kind === TokenKind.QuotedIdent) {
            this.pos++;
            return {
                kind: 'Identifier',
                name: unquote(token.text),
                quoted: true,
                start: token.start,
                end: token.end,
            };
        }
        if (token.kind === TokenKind.Word) {
            this.pos++;
            return { kind: 'Identifier', name: token.text, quoted: false, start: token.start, end: token.end };
        }
        return undefined;
    }

    /** `a`, `a.b`, `a.b.c` */
    private parseName(): NameExpression | undefined {
        const first = this.parseIdentifier();
        if (!first) return undefined;
        const parts = [first];
        while (this.atPunct('.') && this.peek(1) && this.isNameToken(this.peek(1)!)) {
            // A half-typed `e. FROM t` must not swallow the FROM as a name part.
            const next = this.peek(1)!;
            if (this.isKeyword(1) && CLAUSE_BOUNDARY.has(next.upper)) break;
            this.pos++;
            const part = this.parseIdentifier();
            if (!part) break;
            parts.push(part);
        }
        if (parts.length === 1) return first;
        return { kind: 'Qualified', parts, start: first.start, end: parts[parts.length - 1].end };
    }

    private isNameToken(token: Token): boolean {
        return (
            token.kind === TokenKind.Word ||
            token.kind === TokenKind.BacktickIdent ||
            token.kind === TokenKind.QuotedIdent
        );
    }

    /** An alias after an optional AS. */
    private parseAlias(): Identifier | undefined {
        if (this.eat('AS')) {
            const alias = this.parseIdentifier();
            if (!alias) this.error('Expected an alias after AS');
            return alias;
        }
        if (this.atName() && !this.atPunct('(', 1)) return this.parseIdentifier();
        return undefined;
    }

    // ── Expressions ──────────────────────────────────────────────────────────

    parseExpression(minPrecedence = 0): Expression {
        let left = this.parseUnary();

        for (;;) {
            const token = this.peek();
            if (!token) break;

            // `x -> body`
            if (token.kind === TokenKind.Operator && token.text === '->') {
                this.pos++;
                const body = this.parseExpression(0);
                left = {
                    kind: 'Lambda',
                    params: lambdaParams(left),
                    body,
                    start: left.start,
                    end: body.end,
                };
                continue;
            }

            const operator = this.binaryOperatorAt();
            if (!operator) break;
            const precedence = BINARY_PRECEDENCE[operator.key];
            if (precedence === undefined || precedence < minPrecedence) break;

            const operatorStart = this.here;
            this.pos += operator.width;

            // IS [NOT] NULL has no right operand of its own.
            if (operator.key === 'IS') {
                const negated = this.eat('NOT');
                const nullToken = this.peek();
                if (this.at('NULL')) {
                    this.pos++;
                    left = {
                        kind: 'Binary',
                        operator: negated ? 'IS NOT NULL' : 'IS NULL',
                        operatorStart,
                        left,
                        right: { kind: 'NullLiteral', start: nullToken!.start, end: nullToken!.end },
                        start: left.start,
                        end: this.lastEnd,
                    };
                    continue;
                }
                const right = this.parseExpression(precedence + 1);
                left = {
                    kind: 'Binary',
                    operator: negated ? 'IS NOT' : 'IS',
                    operatorStart,
                    left,
                    right,
                    start: left.start,
                    end: right.end,
                };
                continue;
            }

            if (operator.key === 'BETWEEN') {
                const lower = this.parseExpression(BINARY_PRECEDENCE['AND'] + 1);
                this.eat('AND');
                const upper = this.parseExpression(BINARY_PRECEDENCE['AND'] + 1);
                left = {
                    kind: 'Binary',
                    operator: operator.text,
                    operatorStart,
                    left,
                    right: {
                        kind: 'Tuple',
                        items: [lower, upper],
                        start: lower.start,
                        end: upper.end,
                    },
                    start: left.start,
                    end: upper.end,
                };
                continue;
            }

            const right = this.parseExpression(precedence + 1);
            left = {
                kind: 'Binary',
                operator: operator.text,
                operatorStart,
                left,
                right,
                start: left.start,
                end: right.end,
            };
        }

        return left;
    }

    /**
     * Recognise the operator at the cursor, including the multi-word forms
     * `NOT IN`, `GLOBAL IN`, `GLOBAL NOT IN` and `NOT LIKE`.
     */
    private binaryOperatorAt(): { key: string; text: string; width: number } | undefined {
        const token = this.peek();
        if (!token) return undefined;

        if (token.kind === TokenKind.Operator && BINARY_PRECEDENCE[token.text] !== undefined) {
            return { key: token.text, text: token.text, width: 1 };
        }

        if (token.kind !== TokenKind.Word || !this.isKeyword()) return undefined;

        if (this.atSequence('GLOBAL', 'NOT', 'IN')) return { key: 'IN', text: 'GLOBAL NOT IN', width: 3 };
        if (this.atSequence('GLOBAL', 'IN')) return { key: 'IN', text: 'GLOBAL IN', width: 2 };
        if (this.atSequence('NOT', 'IN')) return { key: 'IN', text: 'NOT IN', width: 2 };
        if (this.atSequence('NOT', 'LIKE')) return { key: 'LIKE', text: 'NOT LIKE', width: 2 };
        if (this.atSequence('NOT', 'ILIKE')) return { key: 'ILIKE', text: 'NOT ILIKE', width: 2 };
        if (this.atSequence('NOT', 'BETWEEN')) return { key: 'BETWEEN', text: 'NOT BETWEEN', width: 2 };

        if (BINARY_PRECEDENCE[token.upper] !== undefined) {
            return { key: token.upper, text: token.upper, width: 1 };
        }
        return undefined;
    }

    private parseUnary(): Expression {
        const token = this.peek();
        if (!token) return this.errorExpression('Expected an expression');

        if (token.kind === TokenKind.Operator && (token.text === '-' || token.text === '+')) {
            this.pos++;
            const operand = this.parseUnary();
            return { kind: 'Unary', operator: token.text, operand, start: token.start, end: operand.end };
        }
        if (this.at('NOT')) {
            this.pos++;
            const operand = this.parseExpression(BINARY_PRECEDENCE['AND'] + 1);
            return { kind: 'Unary', operator: 'NOT', operand, start: token.start, end: operand.end };
        }
        return this.parsePostfix(this.parsePrimary());
    }

    private parsePostfix(expression: Expression): Expression {
        for (;;) {
            if (this.atPunct('[')) {
                const open = this.advance()!;
                const index = this.parseExpression(0);
                this.expectPunct(']');
                expression = {
                    kind: 'Subscript',
                    target: expression,
                    index,
                    start: expression.start,
                    end: this.lastEnd || open.end,
                };
                continue;
            }
            if (this.atOperator('::')) {
                this.pos++;
                const typeText = this.captureTypeText();
                expression = {
                    kind: 'CastExpression',
                    value: expression,
                    typeText,
                    start: expression.start,
                    end: this.lastEnd,
                };
                continue;
            }
            // A dangling `.`, which is what `SELECT e.` looks like mid-typing.
            // Consuming it lets the clause after it parse normally.
            if (this.atPunct('.') && this.peek(1)?.kind !== TokenKind.Number) {
                const next = this.peek(1);
                const continues =
                    next && this.isNameToken(next) && !(this.isKeyword(1) && CLAUSE_BOUNDARY.has(next.upper));
                if (!continues) {
                    this.error("Expected a name after '.'", this.peek());
                    this.pos++;
                    continue;
                }
            }

            // Tuple element access: `t.1`
            if (this.atPunct('.') && this.peek(1)?.kind === TokenKind.Number) {
                this.pos++;
                const index = this.advance()!;
                expression = {
                    kind: 'Subscript',
                    target: expression,
                    index: { kind: 'NumberLiteral', text: index.text, start: index.start, end: index.end },
                    start: expression.start,
                    end: index.end,
                };
                continue;
            }
            return expression;
        }
    }

    private parsePrimary(): Expression {
        const token = this.peek();
        if (!token) return this.errorExpression('Expected an expression');

        switch (token.kind) {
            case TokenKind.Number:
                this.pos++;
                return { kind: 'NumberLiteral', text: token.text, start: token.start, end: token.end };
            case TokenKind.String:
            case TokenKind.Heredoc:
                this.pos++;
                return {
                    kind: 'StringLiteral',
                    raw: token.text,
                    value: unquoteString(token.text),
                    start: token.start,
                    end: token.end,
                };
            default:
                break;
        }

        if (token.kind === TokenKind.Operator && token.text === '*') {
            this.pos++;
            return this.parseStarSuffix({ kind: 'Star', start: token.start, end: token.end });
        }

        if (this.atPunct('(')) {
            const open = this.advance()!;
            if (this.at('SELECT') || this.at('WITH')) {
                const select = this.parseSelect();
                this.expectPunct(')');
                return { kind: 'SubqueryExpression', select, start: open.start, end: this.lastEnd };
            }
            const items: Expression[] = [];
            if (!this.atPunct(')')) {
                items.push(this.parseExpression(0));
                while (this.eatPunct(',')) {
                    if (this.atPunct(')')) break;
                    items.push(this.parseExpression(0));
                }
            }
            this.expectPunct(')');
            if (items.length === 1) {
                // Preserve the grouping only as far as offsets go.
                return { ...items[0], start: open.start, end: this.lastEnd } as Expression;
            }
            return { kind: 'Tuple', items, start: open.start, end: this.lastEnd };
        }

        if (this.atPunct('[')) {
            const open = this.advance()!;
            const items: Expression[] = [];
            if (!this.atPunct(']')) {
                items.push(this.parseExpression(0));
                while (this.eatPunct(',')) {
                    if (this.atPunct(']')) break;
                    items.push(this.parseExpression(0));
                }
            }
            this.expectPunct(']');
            return { kind: 'ArrayLiteral', items, start: open.start, end: this.lastEnd };
        }

        if (this.atPunct('{')) {
            const open = this.advance()!;
            const parts: string[] = [];
            while (!this.done && !this.atPunct('}')) parts.push(this.advance()!.text);
            this.expectPunct('}');
            return { kind: 'Placeholder', name: parts.join(''), start: open.start, end: this.lastEnd };
        }

        if (this.at('CASE')) return this.parseCase();
        if (this.at('INTERVAL')) return this.parseInterval();
        if (this.at('NULL')) {
            this.pos++;
            return { kind: 'NullLiteral', start: token.start, end: token.end };
        }
        if (this.atAny('TRUE', 'FALSE')) {
            this.pos++;
            return {
                kind: 'BooleanLiteral',
                value: token.upper === 'TRUE',
                start: token.start,
                end: token.end,
            };
        }
        if (this.at('EXISTS') && this.atPunct('(', 1)) {
            this.pos++;
            const open = this.advance()!;
            const select = this.parseSelect();
            this.expectPunct(')');
            return {
                kind: 'FunctionCall',
                name: 'exists',
                nameStart: token.start,
                nameEnd: token.end,
                args: [{ kind: 'SubqueryExpression', select, start: open.start, end: this.lastEnd }],
                start: token.start,
                end: this.lastEnd,
            };
        }

        if (this.isNameToken(token)) {
            // A keyword here is a syntax error unless it is a name-like builtin.
            if (this.isKeyword() && EXPRESSION_STOP.has(token.upper)) {
                return this.errorExpression(`Unexpected ${token.upper}`);
            }
            const name = this.parseName();
            if (!name) return this.errorExpression('Expected a name');

            if (this.atPunct('(')) return this.parseCallTail(name);
            return name;
        }

        return this.errorExpression(`Unexpected '${token.text}'`);
    }

    /** `SELECT * EXCEPT (a, b)` and `t.*`. */
    private parseStarSuffix(star: import('./ast').Star): Expression {
        if (this.at('EXCEPT') && this.atPunct('(', 1)) {
            this.pos += 2;
            const except: Identifier[] = [];
            while (!this.done && !this.atPunct(')')) {
                const id = this.parseIdentifier();
                if (id) except.push(id);
                else this.pos++;
                if (!this.eatPunct(',')) break;
            }
            this.expectPunct(')');
            return { ...star, except, end: this.lastEnd };
        }
        return star;
    }

    private parseCallTail(name: NameExpression): Expression {
        const nameStart = name.start;
        const nameEnd = name.end;
        const flatName = name.kind === 'Identifier' ? name.name : name.parts.map(p => p.name).join('.');

        let args = this.parseArgumentList();
        let parameters: Expression[] | undefined;

        // `quantile(0.5)(x)` — the first list holds parameters.
        if (this.atPunct('(')) {
            parameters = args.args;
            const second = this.parseArgumentList();
            args = second;
        }

        const call: FunctionCall = {
            kind: 'FunctionCall',
            name: flatName,
            nameStart,
            nameEnd,
            args: args.args,
            start: nameStart,
            end: this.lastEnd,
        };
        if (parameters) call.parameters = parameters;
        if (args.distinct) call.distinct = true;

        // Qualified star inside a call is not a thing; qualified stars come from
        // `t.*`, handled where select items are parsed.
        if (this.at('OVER')) {
            this.pos++;
            if (this.atPunct('(')) {
                call.over = this.parseWindowDefinition();
            } else {
                const windowName = this.parseIdentifier();
                if (windowName) call.over = windowName;
                else this.error('Expected a window name or definition after OVER');
            }
            call.end = this.lastEnd;
        }

        return call;
    }

    private parseArgumentList(): { args: Expression[]; distinct: boolean } {
        this.expectPunct('(');
        const args: Expression[] = [];
        const distinct = this.eat('DISTINCT');
        if (!this.atPunct(')')) {
            for (;;) {
                const before = this.pos;
                if (this.atOperator('*')) {
                    const star = this.advance()!;
                    args.push({ kind: 'Star', start: star.start, end: star.end });
                } else {
                    args.push(this.parseExpression(0));
                }
                if (this.pos === before) {
                    // Nothing consumed — skip a token so the loop terminates.
                    this.pos++;
                }
                if (!this.eatPunct(',')) break;
                if (this.atPunct(')')) break;
            }
        }
        this.expectPunct(')');
        return { args, distinct };
    }

    private parseCase(): Expression {
        const start = this.here;
        this.pos++; // CASE
        const subject = this.at('WHEN') ? undefined : this.parseExpression(0);
        const branches: Array<{ when: Expression; then: Expression }> = [];
        let elseExpression: Expression | undefined;

        while (this.eat('WHEN')) {
            const when = this.parseExpression(0);
            if (!this.eat('THEN')) this.error('Expected THEN');
            const then = this.parseExpression(0);
            branches.push({ when, then });
        }
        if (this.eat('ELSE')) elseExpression = this.parseExpression(0);
        if (!this.eat('END')) this.error('Expected END to close CASE');

        const node: import('./ast').CaseExpression = {
            kind: 'CaseExpression',
            branches,
            start,
            end: this.lastEnd,
        };
        if (subject) node.subject = subject;
        if (elseExpression) node.else = elseExpression;
        return node;
    }

    private parseInterval(): Expression {
        const start = this.here;
        this.pos++; // INTERVAL
        const value = this.parseExpression(BINARY_PRECEDENCE['*'] + 1);
        let unit = '';
        const token = this.peek();
        if (token?.kind === TokenKind.Word && TIME_UNITS.has(token.upper.replace(/S$/, ''))) {
            unit = token.upper;
            this.pos++;
        }
        return { kind: 'IntervalExpression', value, unit, start, end: this.lastEnd };
    }

    /** Balanced token text for a data type, stopping at a column modifier. */
    private captureTypeText(): string {
        const start = this.here;
        let depth = 0;
        while (!this.done) {
            const token = this.peek()!;
            if (token.kind === TokenKind.Punct && (token.text === '(' || token.text === '[')) depth++;
            else if (token.kind === TokenKind.Punct && (token.text === ')' || token.text === ']')) {
                if (depth === 0) break;
                depth--;
            } else if (depth === 0) {
                if (token.kind === TokenKind.Punct && (token.text === ',' || token.text === ';')) break;
                if (this.isKeyword() && COLUMN_MODIFIERS.has(token.upper)) break;
                if (token.kind === TokenKind.Operator && token.text !== '*') break;
            }
            this.pos++;
        }
        return this.text.slice(start, this.lastEnd).trim();
    }

    private errorExpression(message: string): Expression {
        const token = this.peek();
        this.error(message, token);
        const start = token?.start ?? this.text.length;
        const end = token?.end ?? this.text.length;
        if (token) this.pos++;
        return { kind: 'ErrorExpression', text: token?.text ?? '', start, end };
    }

    // ── SELECT ───────────────────────────────────────────────────────────────

    parseSelect(): SelectStatement {
        const start = this.here;
        const ctes = this.at('WITH') ? this.parseWith() : [];

        const node: SelectStatement = {
            kind: 'SelectStatement',
            ctes,
            distinct: false,
            columns: [],
            groupBy: [],
            windows: [],
            orderBy: [],
            settings: [],
            setOperations: [],
            start,
            end: start,
        };

        if (!this.eat('SELECT')) {
            this.error('Expected SELECT');
            node.end = this.lastEnd || start;
            return node;
        }
        node.distinct = this.eat('DISTINCT');

        node.columns = this.parseSelectItems();

        if (this.at('FROM')) node.from = this.parseFrom();
        if (this.eat('PREWHERE')) node.prewhere = this.parseExpression(0);
        if (this.eat('WHERE')) node.where = this.parseExpression(0);

        if (this.eatSequence('GROUP', 'BY')) {
            node.groupBy = this.parseExpressionList();
            if (this.eatSequence('WITH', 'TOTALS')) node.groupByModifier = 'WITH TOTALS';
            else if (this.eatSequence('WITH', 'ROLLUP')) node.groupByModifier = 'WITH ROLLUP';
            else if (this.eatSequence('WITH', 'CUBE')) node.groupByModifier = 'WITH CUBE';
        }
        if (this.eat('HAVING')) node.having = this.parseExpression(0);
        if (this.eat('WINDOW')) node.windows = this.parseNamedWindows();
        if (this.eat('QUALIFY')) node.qualify = this.parseExpression(0);
        if (this.eatSequence('ORDER', 'BY')) node.orderBy = this.parseOrderBy();

        if (this.at('LIMIT')) {
            this.pos++;
            const count = this.parseExpression(0);
            if (this.eat('BY')) {
                node.limitBy = { count, by: this.parseExpressionList() };
            } else {
                node.limit = count;
                if (this.eat('OFFSET')) node.offset = this.parseExpression(0);
                // `LIMIT offset, count` — the first number is the offset.
                if (this.eatPunct(',')) {
                    node.offset = count;
                    node.limit = this.parseExpression(0);
                }
            }
        }
        if (this.at('LIMIT')) {
            // A LIMIT BY may be followed by the real LIMIT.
            this.pos++;
            node.limit = this.parseExpression(0);
        }
        if (this.eat('OFFSET')) node.offset = this.parseExpression(0);
        if (this.eat('SETTINGS')) node.settings = this.parseSettings();
        if (this.eat('FORMAT')) node.format = this.parseIdentifier();

        // Set operations chain onto the same node.
        for (;;) {
            let operator: string | undefined;
            if (this.eatSequence('UNION', 'ALL')) operator = 'UNION ALL';
            else if (this.eatSequence('UNION', 'DISTINCT')) operator = 'UNION DISTINCT';
            else if (this.eat('UNION')) operator = 'UNION';
            else if (this.eat('INTERSECT')) operator = 'INTERSECT';
            else if (this.eat('EXCEPT')) operator = 'EXCEPT';
            if (!operator) break;
            node.setOperations.push({ operator, select: this.parseSelect() });
        }

        if (this.eat('SETTINGS')) node.settings.push(...this.parseSettings());
        if (this.eat('FORMAT')) node.format = this.parseIdentifier() ?? node.format;

        node.end = this.lastEnd || start;
        return node;
    }

    private parseWith(): Cte[] {
        this.pos++; // WITH
        const ctes: Cte[] = [];
        for (;;) {
            const start = this.here;

            // `WITH (SELECT …) AS name` and `WITH expr AS name`
            if (!this.atName() || (this.peek(1) && !this.isKeyword(1, 'AS'))) {
                const before = this.pos;
                const expression = this.parseExpression(0);
                if (this.eat('AS')) {
                    const name = this.parseIdentifier();
                    if (name) {
                        ctes.push({ kind: 'Cte', name, expression, start, end: this.lastEnd });
                    }
                } else if (this.pos === before) {
                    this.pos++;
                }
                if (!this.eatPunct(',')) break;
                continue;
            }

            const name = this.parseIdentifier();
            if (!name) break;
            if (!this.eat('AS')) {
                this.error('Expected AS in a WITH clause');
                break;
            }
            if (this.atPunct('(')) {
                this.pos++;
                const select = this.parseSelect();
                this.expectPunct(')');
                ctes.push({ kind: 'Cte', name, select, start, end: this.lastEnd });
            } else {
                const expression = this.parseExpression(0);
                ctes.push({ kind: 'Cte', name, expression, start, end: this.lastEnd });
            }
            if (!this.eatPunct(',')) break;
        }
        return ctes;
    }

    private parseSelectItems(): SelectItem[] {
        const items: SelectItem[] = [];
        for (;;) {
            if (this.atClauseBoundary()) {
                if (items.length > 0) this.error('Trailing comma before the next clause');
                break;
            }
            const before = this.pos;
            const start = this.here;

            // `t.*`
            let expression: Expression;
            if (this.atName() && this.atPunct('.', 1) && this.atOperator('*', 2)) {
                const qualifier = this.parseIdentifier()!;
                this.pos++; // .
                const star = this.advance()!;
                expression = this.parseStarSuffix({
                    kind: 'Star',
                    qualifier,
                    start: qualifier.start,
                    end: star.end,
                });
            } else {
                expression = this.parseExpression(0);
            }

            const alias = this.parseAlias();
            const item: SelectItem = { kind: 'SelectItem', expression, start, end: this.lastEnd };
            if (alias) item.alias = alias;
            items.push(item);

            if (this.pos === before) this.pos++;
            if (!this.eatPunct(',')) break;
        }
        return items;
    }

    private parseExpressionList(): Expression[] {
        const items: Expression[] = [];
        for (;;) {
            if (this.atClauseBoundary()) {
                if (items.length > 0) this.error('Trailing comma before the next clause');
                break;
            }
            const before = this.pos;
            items.push(this.parseExpression(0));
            if (this.pos === before) this.pos++;
            if (!this.eatPunct(',')) break;
        }
        return items;
    }

    private parseOrderBy(): OrderByItem[] {
        const items: OrderByItem[] = [];
        for (;;) {
            if (this.atClauseBoundary()) {
                if (items.length > 0) this.error('Trailing comma before the next clause');
                break;
            }
            const before = this.pos;
            const start = this.here;
            const expression = this.parseExpression(0);
            const item: OrderByItem = { kind: 'OrderByItem', expression, withFill: false, start, end: this.lastEnd };
            if (this.eat('ASC')) item.direction = 'ASC';
            else if (this.eat('DESC')) item.direction = 'DESC';
            if (this.eat('NULLS')) {
                if (this.eat('FIRST')) item.nulls = 'FIRST';
                else if (this.eat('LAST')) item.nulls = 'LAST';
            }
            if (this.eatSequence('WITH', 'FILL')) {
                item.withFill = true;
                // FROM/TO/STEP are consumed as plain expressions.
                while (this.atAny('FROM', 'TO', 'STEP')) {
                    this.pos++;
                    this.parseExpression(0);
                }
            }
            item.end = this.lastEnd;
            items.push(item);
            if (this.pos === before) this.pos++;
            if (!this.eatPunct(',')) break;
        }
        return items;
    }

    private parseNamedWindows(): WindowDefinition[] {
        const windows: WindowDefinition[] = [];
        for (;;) {
            const name = this.parseIdentifier();
            if (!name) break;
            if (!this.eat('AS')) {
                this.error('Expected AS in a WINDOW clause');
                break;
            }
            const definition = this.parseWindowDefinition();
            definition.name = name;
            definition.start = name.start;
            windows.push(definition);
            if (!this.eatPunct(',')) break;
        }
        return windows;
    }

    private parseWindowDefinition(): WindowDefinition {
        const start = this.here;
        const node: WindowDefinition = {
            kind: 'WindowDefinition',
            partitionBy: [],
            orderBy: [],
            start,
            end: start,
        };
        if (!this.eatPunct('(')) {
            this.error('Expected ( to open a window definition');
            node.end = this.lastEnd;
            return node;
        }
        if (this.eatSequence('PARTITION', 'BY')) node.partitionBy = this.parseExpressionList();
        if (this.eatSequence('ORDER', 'BY')) node.orderBy = this.parseOrderBy();
        if (this.atAny('ROWS', 'RANGE', 'GROUPS')) {
            const frameStart = this.here;
            let depth = 0;
            while (!this.done) {
                if (this.atPunct('(')) depth++;
                if (this.atPunct(')')) {
                    if (depth === 0) break;
                    depth--;
                }
                this.pos++;
            }
            node.frame = this.text.slice(frameStart, this.lastEnd).trim();
        }
        this.expectPunct(')');
        node.end = this.lastEnd;
        return node;
    }

    private parseSettings(): SettingAssignment[] {
        const settings: SettingAssignment[] = [];
        for (;;) {
            const name = this.parseIdentifier();
            if (!name) break;
            const assignment: SettingAssignment = {
                kind: 'SettingAssignment',
                name,
                start: name.start,
                end: name.end,
            };
            if (this.atOperator('=')) {
                this.pos++;
                assignment.value = this.parseExpression(BINARY_PRECEDENCE['||']);
                assignment.end = this.lastEnd;
            }
            settings.push(assignment);
            if (!this.eatPunct(',')) break;
        }
        return settings;
    }

    // ── FROM ─────────────────────────────────────────────────────────────────

    private parseFrom(): FromClause {
        const start = this.here;
        this.pos++; // FROM
        const node: FromClause = { kind: 'FromClause', joins: [], start, end: start };
        node.source = this.parseTableSource();

        for (;;) {
            if (this.at('ARRAY') || this.atSequence('LEFT', 'ARRAY')) {
                node.arrayJoin = this.parseArrayJoin();
                continue;
            }
            const join = this.parseJoin();
            if (!join) break;
            node.joins.push(join);
        }

        node.end = this.lastEnd;
        return node;
    }

    private parseTableSource(): TableSource | undefined {
        const start = this.here;

        if (this.atPunct('(')) {
            this.pos++;
            const select = this.parseSelect();
            this.expectPunct(')');
            const node: import('./ast').SubquerySource = {
                kind: 'SubquerySource',
                select,
                start,
                end: this.lastEnd,
            };
            const alias = this.parseAlias();
            if (alias) {
                node.alias = alias;
                node.end = alias.end;
            }
            return node;
        }

        if (!this.atName()) {
            this.error('Expected a table name');
            return undefined;
        }

        const name = this.parseName()!;

        if (this.atPunct('(')) {
            const call = this.parseCallTail(name) as FunctionCall;
            const node: import('./ast').TableFunctionSource = {
                kind: 'TableFunctionSource',
                call,
                start,
                end: call.end,
            };
            const alias = this.parseAlias();
            if (alias) {
                node.alias = alias;
                node.end = alias.end;
            }
            return node;
        }

        const parts = name.kind === 'Identifier' ? [name] : name.parts;
        const node: TableRef = {
            kind: 'TableRef',
            table: parts[parts.length - 1],
            final: false,
            start,
            end: name.end,
        };
        if (parts.length > 1) node.database = parts[parts.length - 2];

        const alias = this.parseAlias();
        if (alias) {
            node.alias = alias;
            node.end = alias.end;
        }
        if (this.eat('FINAL')) {
            node.final = true;
            node.end = this.lastEnd;
        }
        // FINAL may precede the alias.
        if (!node.alias) {
            const late = this.parseAlias();
            if (late) {
                node.alias = late;
                node.end = late.end;
            }
        }
        if (this.eat('SAMPLE')) {
            this.parseExpression(0);
            node.end = this.lastEnd;
        }
        return node;
    }

    private parseJoin(): Join | undefined {
        const start = this.here;
        let offset = 0;
        while (this.isKeyword(offset) && JOIN_MODIFIERS.has(this.peek(offset)!.upper)) offset++;
        if (!this.isKeyword(offset, 'JOIN')) {
            // `CROSS JOIN` may also be written as a comma.
            if (this.atPunct(',')) {
                this.pos++;
                const source = this.parseTableSource();
                if (!source) return undefined;
                return { kind: 'Join', joinType: 'CROSS JOIN', source, start, end: this.lastEnd };
            }
            return undefined;
        }

        const words: string[] = [];
        for (let i = 0; i <= offset; i++) words.push(this.peek(i)!.upper);
        this.pos += offset + 1;

        const source = this.parseTableSource();
        const node: Join = {
            kind: 'Join',
            joinType: words.join(' '),
            source: source ?? { kind: 'TableRef', table: { kind: 'Identifier', name: '', quoted: false, start, end: start }, final: false, start, end: start },
            start,
            end: this.lastEnd,
        };

        if (this.eat('ON')) {
            node.on = this.parseExpression(0);
        } else if (this.eat('USING')) {
            const columns: Identifier[] = [];
            const parenthesised = this.eatPunct('(');
            for (;;) {
                const id = this.parseIdentifier();
                if (!id) break;
                columns.push(id);
                if (!this.eatPunct(',')) break;
            }
            if (parenthesised) this.expectPunct(')');
            node.using = columns;
        } else if (!node.joinType.includes('CROSS') && !node.joinType.includes('PASTE')) {
            this.error(`${node.joinType} requires ON or USING`, this.peek() ?? undefined);
        }

        node.end = this.lastEnd;
        return node;
    }

    private parseArrayJoin(): ArrayJoinClause {
        const start = this.here;
        const left = this.eat('LEFT');
        this.eat('ARRAY');
        this.eat('JOIN');
        const items: SelectItem[] = [];
        for (;;) {
            const before = this.pos;
            const itemStart = this.here;
            const expression = this.parseExpression(0);
            const alias = this.parseAlias();
            const item: SelectItem = { kind: 'SelectItem', expression, start: itemStart, end: this.lastEnd };
            if (alias) item.alias = alias;
            items.push(item);
            if (this.pos === before) this.pos++;
            if (!this.eatPunct(',')) break;
        }
        return { kind: 'ArrayJoinClause', left, items, start, end: this.lastEnd };
    }

    // ── Other statements ─────────────────────────────────────────────────────

    private parseInsert(): InsertStatement {
        const start = this.here;
        this.eatSequence('INSERT', 'INTO');
        const node: InsertStatement = { kind: 'InsertStatement', columns: [], settings: [], start, end: start };

        this.eat('TABLE');
        // A parenthesised list after the name is the column list, not a call.
        if (this.atName()) {
            const name = this.parseName()!;
            const parts = name.kind === 'Identifier' ? [name] : name.parts;
            node.table = {
                kind: 'TableRef',
                table: parts[parts.length - 1],
                final: false,
                start: name.start,
                end: name.end,
            };
            if (parts.length > 1) node.table.database = parts[parts.length - 2];
        }

        if (this.atPunct('(')) {
            this.pos++;
            for (;;) {
                const id = this.parseIdentifier();
                if (!id) break;
                node.columns.push(id);
                if (!this.eatPunct(',')) break;
            }
            this.expectPunct(')');
        }

        if (this.eat('SETTINGS')) node.settings = this.parseSettings();

        if (this.at('SELECT') || this.at('WITH')) {
            node.select = this.parseSelect();
        } else if (this.eat('VALUES')) {
            let count = 0;
            while (this.atPunct('(')) {
                this.skipBalanced();
                count++;
                if (!this.eatPunct(',')) break;
            }
            node.valuesCount = count;
        }

        node.end = this.lastEnd;
        return node;
    }

    private parseCreateTable(): CreateTableStatement {
        const start = this.here;
        this.eat('CREATE');
        this.eat('OR');
        this.eat('REPLACE');
        const temporary = this.eat('TEMPORARY');
        this.eat('TABLE');
        const ifNotExists = this.eatSequence('IF', 'NOT', 'EXISTS');

        const node: CreateTableStatement = {
            kind: 'CreateTableStatement',
            ifNotExists,
            temporary,
            columns: [],
            orderBy: [],
            partitionBy: [],
            primaryKey: [],
            settings: [],
            start,
            end: start,
        };

        if (this.atName()) {
            const name = this.parseName()!;
            const parts = name.kind === 'Identifier' ? [name] : name.parts;
            node.table = {
                kind: 'TableRef',
                table: parts[parts.length - 1],
                final: false,
                start: name.start,
                end: name.end,
            };
            if (parts.length > 1) node.table.database = parts[parts.length - 2];
        }

        this.eatSequence('ON', 'CLUSTER');
        if (this.atName() && !this.atPunct('(')) this.parseIdentifier();

        if (this.atPunct('(')) {
            this.pos++;
            node.columns = this.parseColumnDefinitions();
            this.expectPunct(')');
        }

        for (;;) {
            if (this.eat('ENGINE')) {
                if (this.atOperator('=')) this.pos++;
                const engineStart = this.here;
                if (this.atName()) this.parseIdentifier();
                if (this.atPunct('(')) this.skipBalanced();
                node.engine = this.text.slice(engineStart, this.lastEnd).trim();
                continue;
            }
            if (this.eatSequence('PARTITION', 'BY')) {
                node.partitionBy = this.parseExpressionList();
                continue;
            }
            if (this.eatSequence('PRIMARY', 'KEY')) {
                node.primaryKey = this.parseExpressionList();
                continue;
            }
            if (this.eatSequence('ORDER', 'BY')) {
                node.orderBy = this.parseExpressionList();
                continue;
            }
            if (this.eatSequence('SAMPLE', 'BY')) {
                node.sampleBy = this.parseExpression(0);
                continue;
            }
            if (this.eat('TTL')) {
                node.ttl = this.parseExpression(0);
                continue;
            }
            if (this.eat('SETTINGS')) {
                node.settings = this.parseSettings();
                continue;
            }
            if (this.eat('COMMENT')) {
                this.parseExpression(0);
                continue;
            }
            if (this.eat('AS')) {
                if (this.at('SELECT') || this.at('WITH')) node.select = this.parseSelect();
                else if (this.atName()) this.parseName();
                continue;
            }
            break;
        }

        node.end = this.lastEnd;
        return node;
    }

    private parseColumnDefinitions(): ColumnDefinition[] {
        const columns: ColumnDefinition[] = [];
        for (;;) {
            if (this.atPunct(')') || this.done) break;
            const before = this.pos;

            // Skip index/projection/constraint declarations.
            if (this.atAny('INDEX', 'PROJECTION', 'CONSTRAINT')) {
                while (!this.done && !this.atPunct(')') && !this.atPunct(',')) {
                    if (this.atPunct('(')) this.skipBalanced();
                    else this.pos++;
                }
                if (!this.eatPunct(',')) break;
                continue;
            }

            const name = this.parseIdentifier();
            if (!name) {
                if (this.pos === before) this.pos++;
                if (!this.eatPunct(',')) break;
                continue;
            }

            const column: ColumnDefinition = {
                kind: 'ColumnDefinition',
                name,
                typeText: this.captureTypeText(),
                start: name.start,
                end: this.lastEnd,
            };

            for (;;) {
                if (this.atAny('DEFAULT', 'MATERIALIZED', 'ALIAS', 'EPHEMERAL')) {
                    column.defaultKind = this.peek()!.upper as ColumnDefinition['defaultKind'];
                    this.pos++;
                    column.defaultExpression = this.parseExpression(0);
                    continue;
                }
                if (this.eat('CODEC')) {
                    const codecStart = this.here;
                    if (this.atPunct('(')) this.skipBalanced();
                    column.codec = this.text.slice(codecStart, this.lastEnd).trim();
                    continue;
                }
                if (this.eat('TTL')) {
                    column.ttl = this.parseExpression(0);
                    continue;
                }
                if (this.eat('COMMENT')) {
                    const comment = this.peek();
                    if (comment?.kind === TokenKind.String) {
                        column.comment = unquoteString(comment.text);
                        this.pos++;
                    }
                    continue;
                }
                if (this.eatSequence('NOT', 'NULL') || this.eat('NULL')) continue;
                if (this.eatSequence('PRIMARY', 'KEY')) continue;
                break;
            }

            column.end = this.lastEnd;
            columns.push(column);

            if (this.pos === before) this.pos++;
            if (!this.eatPunct(',')) break;
        }
        return columns;
    }

    private parseCreateView(): CreateViewStatement {
        const start = this.here;
        this.eat('CREATE');
        this.eat('OR');
        this.eat('REPLACE');
        const materialized = this.eat('MATERIALIZED');
        this.eat('LIVE');
        this.eat('WINDOW');
        this.eat('VIEW');
        const ifNotExists = this.eatSequence('IF', 'NOT', 'EXISTS');

        const node: CreateViewStatement = {
            kind: 'CreateViewStatement',
            materialized,
            ifNotExists,
            populate: false,
            start,
            end: start,
        };

        if (this.atName()) {
            const name = this.parseName()!;
            const parts = name.kind === 'Identifier' ? [name] : name.parts;
            node.view = {
                kind: 'TableRef',
                table: parts[parts.length - 1],
                final: false,
                start: name.start,
                end: name.end,
            };
            if (parts.length > 1) node.view.database = parts[parts.length - 2];
        }

        this.eatSequence('ON', 'CLUSTER');

        if (this.eat('TO')) {
            const target = this.parseName();
            if (target) {
                const parts = target.kind === 'Identifier' ? [target] : target.parts;
                node.to = {
                    kind: 'TableRef',
                    table: parts[parts.length - 1],
                    final: false,
                    start: target.start,
                    end: target.end,
                };
                if (parts.length > 1) node.to.database = parts[parts.length - 2];
            }
        }

        if (this.eat('ENGINE')) {
            if (this.atOperator('=')) this.pos++;
            const engineStart = this.here;
            if (this.atName()) this.parseIdentifier();
            if (this.atPunct('(')) this.skipBalanced();
            node.engine = this.text.slice(engineStart, this.lastEnd).trim();
        }
        // Table properties before AS SELECT.
        while (this.atAny('PARTITION', 'ORDER', 'PRIMARY', 'SAMPLE', 'TTL', 'SETTINGS')) {
            this.pos++;
            this.eat('BY');
            this.eat('KEY');
            if (this.at('SELECT')) break;
            this.parseExpressionList();
        }
        node.populate = this.eat('POPULATE');

        if (this.eat('AS')) {
            if (this.at('SELECT') || this.at('WITH')) node.select = this.parseSelect();
        }

        node.end = this.lastEnd;
        return node;
    }

    private parseAlterTable(): AlterTableStatement {
        const start = this.here;
        this.eat('ALTER');
        this.eat('TABLE');
        const node: AlterTableStatement = { kind: 'AlterTableStatement', actions: [], start, end: start };

        if (this.atName()) {
            const name = this.parseName()!;
            const parts = name.kind === 'Identifier' ? [name] : name.parts;
            node.table = {
                kind: 'TableRef',
                table: parts[parts.length - 1],
                final: false,
                start: name.start,
                end: name.end,
            };
            if (parts.length > 1) node.table.database = parts[parts.length - 2];
        }
        this.eatSequence('ON', 'CLUSTER');

        for (;;) {
            const actionStart = this.here;
            let depth = 0;
            while (!this.done) {
                if (this.atPunct('(') || this.atPunct('[')) depth++;
                else if (this.atPunct(')') || this.atPunct(']')) depth--;
                else if (depth === 0 && this.atPunct(';')) break;
                else if (depth === 0 && this.atPunct(',')) break;
                else if (depth === 0 && this.at('WHERE')) break;
                this.pos++;
            }
            const action = this.text.slice(actionStart, this.lastEnd).trim();
            if (action) node.actions.push(action);
            if (this.eat('WHERE')) {
                node.where = this.parseExpression(0);
            }
            if (!this.eatPunct(',')) break;
        }

        node.end = this.lastEnd;
        return node;
    }

    private parseDrop(): DropStatement {
        const start = this.here;
        const what: string[] = [];
        while (this.isKeyword() && !this.atName()) {
            const token = this.peek()!;
            what.push(token.upper);
            this.pos++;
            if (['TABLE', 'DATABASE', 'VIEW', 'DICTIONARY', 'FUNCTION', 'USER', 'ROLE'].includes(token.upper)) break;
        }
        const ifExists = this.eatSequence('IF', 'EXISTS');
        const node: DropStatement = { kind: 'DropStatement', what: what.join(' '), ifExists, start, end: this.lastEnd };

        if (this.atName()) {
            const name = this.parseName()!;
            const parts = name.kind === 'Identifier' ? [name] : name.parts;
            node.target = {
                kind: 'TableRef',
                table: parts[parts.length - 1],
                final: false,
                start: name.start,
                end: name.end,
            };
            if (parts.length > 1) node.target.database = parts[parts.length - 2];
        }
        node.end = this.lastEnd;
        return node;
    }

    private skipBalanced(): void {
        if (!this.atPunct('(') && !this.atPunct('[')) return;
        let depth = 0;
        while (!this.done) {
            if (this.atPunct('(') || this.atPunct('[')) depth++;
            else if (this.atPunct(')') || this.atPunct(']')) {
                depth--;
                if (depth === 0) {
                    this.pos++;
                    return;
                }
            }
            this.pos++;
        }
    }

    // ── Program ──────────────────────────────────────────────────────────────

    parseProgram(): ParseResult {
        const statements: Statement[] = [];
        const start = this.here;

        while (!this.done) {
            if (this.eatPunct(';')) continue;
            const before = this.pos;
            const statement = this.parseStatement();
            if (statement) statements.push(statement);

            if (this.pos === before) {
                // The statement rule made no progress; skip a token to terminate.
                this.error(`Unexpected '${this.peek()?.text ?? ''}'`);
                this.pos++;
            }

            // Anything left before the next `;` is unexpected.
            if (!this.done && !this.atPunct(';')) {
                this.error(`Unexpected '${this.peek()?.text ?? ''}'`);
                this.skipToStatementEnd();
            }
            this.eatPunct(';');

            if (++this.guard > 10000) break;
        }

        return {
            program: {
                kind: 'Program',
                statements,
                start,
                end: this.text.length,
            },
            diagnostics: this.diagnostics,
        };
    }

    private skipToStatementEnd(): void {
        let depth = 0;
        while (!this.done) {
            if (this.atPunct('(') || this.atPunct('[')) depth++;
            else if (this.atPunct(')') || this.atPunct(']')) depth--;
            else if (depth <= 0 && this.atPunct(';')) return;
            this.pos++;
        }
    }

    private parseStatement(): Statement | undefined {
        const start = this.here;

        if (this.at('SELECT') || this.at('WITH')) return this.parseSelect();
        if (this.at('INSERT')) return this.parseInsert();
        if (this.at('ALTER')) return this.parseAlterTable();
        if (this.atAny('DROP', 'TRUNCATE', 'DETACH')) return this.parseDrop();

        if (this.at('CREATE')) {
            // Look ahead past CREATE [OR REPLACE] [TEMPORARY|MATERIALIZED|LIVE|WINDOW].
            let offset = 1;
            if (this.isKeyword(offset, 'OR') && this.isKeyword(offset + 1, 'REPLACE')) offset += 2;
            while (this.isKeyword(offset) && ['TEMPORARY', 'MATERIALIZED', 'LIVE', 'WINDOW'].includes(this.peek(offset)!.upper)) {
                offset++;
            }
            if (this.isKeyword(offset, 'VIEW')) return this.parseCreateView();
            if (this.isKeyword(offset, 'TABLE')) return this.parseCreateTable();
        }

        // Everything else is recorded but not modelled.
        const lead: string[] = [];
        while (!this.done && !this.atPunct(';') && lead.length < 4) {
            const token = this.peek()!;
            if (token.kind !== TokenKind.Word) break;
            lead.push(token.upper);
            this.pos++;
        }
        if (lead.length === 0) return undefined;
        this.skipToStatementEnd();
        return { kind: 'OtherStatement', lead: lead.join(' '), start, end: this.lastEnd };
    }
}

function unquote(text: string): string {
    if (text.length >= 2) {
        const first = text[0];
        const last = text[text.length - 1];
        if ((first === '`' && last === '`') || (first === '"' && last === '"')) {
            return text
                .slice(1, -1)
                .replace(/\\(.)/g, '$1')
                .replace(new RegExp(`${first}${first}`, 'g'), first);
        }
    }
    return text;
}

function unquoteString(text: string): string {
    if (text.length >= 2 && text[0] === "'" && text[text.length - 1] === "'") {
        return text.slice(1, -1).replace(/\\(.)/g, '$1').replace(/''/g, "'");
    }
    return text;
}

/** Lambda parameters: `x -> …` or `(x, y) -> …`. */
function lambdaParams(expression: Expression): Identifier[] {
    if (expression.kind === 'Identifier') return [expression];
    if (expression.kind === 'Tuple') {
        return expression.items.filter((item): item is Identifier => item.kind === 'Identifier');
    }
    return [];
}

export function parse(text: string): ParseResult {
    return new Parser(text).parseProgram();
}

/** Parse a single expression, for tests and small tools. */
export function parseExpressionText(text: string): Expression {
    const parser = new Parser(text);
    return parser.parseExpression(0);
}
