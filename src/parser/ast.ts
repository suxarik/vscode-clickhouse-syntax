/**
 * Syntax tree for ClickHouse SQL.
 *
 * The tree is produced by an error-tolerant parser, so every node carries source
 * offsets and any region that could not be parsed becomes an `Error` node rather
 * than aborting the parse. Half-typed queries still yield a usable tree, which is
 * what completion and diagnostics need.
 */

export type StatementKind =
    | 'SelectStatement'
    | 'InsertStatement'
    | 'CreateTableStatement'
    | 'CreateViewStatement'
    | 'AlterTableStatement'
    | 'DropStatement'
    | 'OtherStatement';

export type ExpressionKind =
    | 'Identifier'
    | 'Qualified'
    | 'NumberLiteral'
    | 'StringLiteral'
    | 'BooleanLiteral'
    | 'NullLiteral'
    | 'FunctionCall'
    | 'Binary'
    | 'Unary'
    | 'Lambda'
    | 'CaseExpression'
    | 'CastExpression'
    | 'IntervalExpression'
    | 'Tuple'
    | 'ArrayLiteral'
    | 'Subscript'
    | 'Star'
    | 'SubqueryExpression'
    | 'Placeholder'
    | 'TemplateExpression'
    | 'ErrorExpression';

export type NodeKind =
    | 'Program'
    | StatementKind
    | ExpressionKind
    | 'Cte'
    | 'SelectItem'
    | 'FromClause'
    | 'Join'
    | 'TableRef'
    | 'TableFunctionSource'
    | 'SubquerySource'
    | 'ArrayJoinClause'
    | 'OrderByItem'
    | 'WindowDefinition'
    | 'SettingAssignment'
    | 'ColumnDefinition';

export interface NodeBase {
    kind: NodeKind;
    /** Offset of the node's first character. */
    start: number;
    /** Offset one past the node's last character. */
    end: number;
}

// ── Names ────────────────────────────────────────────────────────────────────

export interface Identifier extends NodeBase {
    kind: 'Identifier';
    /** Unquoted text. */
    name: string;
    /** True when written as `` `x` `` or `"x"`. */
    quoted: boolean;
}

/** `db.table`, `t.col`, `db.table.col`. */
export interface Qualified extends NodeBase {
    kind: 'Qualified';
    parts: Identifier[];
}

export type NameExpression = Identifier | Qualified;

// ── Expressions ──────────────────────────────────────────────────────────────

export interface NumberLiteral extends NodeBase {
    kind: 'NumberLiteral';
    text: string;
}

export interface StringLiteral extends NodeBase {
    kind: 'StringLiteral';
    /** Literal text including quotes. */
    raw: string;
    value: string;
}

export interface BooleanLiteral extends NodeBase {
    kind: 'BooleanLiteral';
    value: boolean;
}

export interface NullLiteral extends NodeBase {
    kind: 'NullLiteral';
}

export interface FunctionCall extends NodeBase {
    kind: 'FunctionCall';
    name: string;
    nameStart: number;
    nameEnd: number;
    /** Parameters of a parameterised aggregate: `quantile(0.5)(x)`. */
    parameters?: Expression[];
    args: Expression[];
    /** `count(DISTINCT x)`. */
    distinct?: boolean;
    /** `sum(x) OVER (...)` or `sum(x) OVER w`. */
    over?: WindowDefinition | Identifier;
}

export interface Binary extends NodeBase {
    kind: 'Binary';
    operator: string;
    operatorStart: number;
    left: Expression;
    right: Expression;
}

export interface Unary extends NodeBase {
    kind: 'Unary';
    operator: string;
    operand: Expression;
}

export interface Lambda extends NodeBase {
    kind: 'Lambda';
    params: Identifier[];
    body: Expression;
}

export interface CaseExpression extends NodeBase {
    kind: 'CaseExpression';
    /** Present for the `CASE expr WHEN ...` form. */
    subject?: Expression;
    branches: Array<{ when: Expression; then: Expression }>;
    else?: Expression;
}

export interface CastExpression extends NodeBase {
    kind: 'CastExpression';
    value: Expression;
    typeText: string;
}

export interface IntervalExpression extends NodeBase {
    kind: 'IntervalExpression';
    value: Expression;
    unit: string;
}

export interface Tuple extends NodeBase {
    kind: 'Tuple';
    items: Expression[];
}

export interface ArrayLiteral extends NodeBase {
    kind: 'ArrayLiteral';
    items: Expression[];
}

export interface Subscript extends NodeBase {
    kind: 'Subscript';
    target: Expression;
    index: Expression;
}

/** `*` or `t.*` */
export interface Star extends NodeBase {
    kind: 'Star';
    qualifier?: Identifier;
    /** `SELECT * EXCEPT (a, b)` */
    except?: Identifier[];
}

export interface SubqueryExpression extends NodeBase {
    kind: 'SubqueryExpression';
    select: SelectStatement;
}

/** `{name:Type}` query parameters. */
export interface Placeholder extends NodeBase {
    kind: 'Placeholder';
    name: string;
}

/**
 * A Jinja tag standing where a value or a name would: `{{ ref('users') }}`.
 *
 * Left opaque on purpose. A dbt model is not ClickHouse SQL until dbt has
 * compiled it, and the useful thing is not to guess at the expansion but to
 * stop pretending the surrounding statement is broken.
 */
export interface TemplateExpression extends NodeBase {
    kind: 'TemplateExpression';
    /** The whole tag, braces included. */
    text: string;
    /** `ref` or `source` when the tag is one of those, for resolution. */
    call?: 'ref' | 'source';
    /** String arguments of that call, in order. */
    arguments?: string[];
}

export interface ErrorExpression extends NodeBase {
    kind: 'ErrorExpression';
    text: string;
}

export type Expression =
    | Identifier
    | Qualified
    | NumberLiteral
    | StringLiteral
    | BooleanLiteral
    | NullLiteral
    | FunctionCall
    | Binary
    | Unary
    | Lambda
    | CaseExpression
    | CastExpression
    | IntervalExpression
    | Tuple
    | ArrayLiteral
    | Subscript
    | Star
    | SubqueryExpression
    | Placeholder
    | TemplateExpression
    | ErrorExpression;

// ── Query structure ──────────────────────────────────────────────────────────

export interface SelectItem extends NodeBase {
    kind: 'SelectItem';
    expression: Expression;
    alias?: Identifier;
}

export interface TableRef extends NodeBase {
    kind: 'TableRef';
    database?: Identifier;
    table: Identifier;
    alias?: Identifier;
    final: boolean;
    /** Set when the name was a Jinja tag rather than an identifier. */
    template?: TemplateExpression;
}

export interface TableFunctionSource extends NodeBase {
    kind: 'TableFunctionSource';
    call: FunctionCall;
    alias?: Identifier;
}

export interface SubquerySource extends NodeBase {
    kind: 'SubquerySource';
    select: SelectStatement;
    alias?: Identifier;
}

export type TableSource = TableRef | TableFunctionSource | SubquerySource;

export interface Join extends NodeBase {
    kind: 'Join';
    /** Normalised, e.g. `LEFT JOIN`, `ASOF JOIN`, `CROSS JOIN`. */
    joinType: string;
    source: TableSource;
    on?: Expression;
    using?: Identifier[];
}

/** `ARRAY JOIN a AS x, b` */
export interface ArrayJoinClause extends NodeBase {
    kind: 'ArrayJoinClause';
    left: boolean;
    items: SelectItem[];
}

export interface FromClause extends NodeBase {
    kind: 'FromClause';
    source?: TableSource;
    joins: Join[];
    arrayJoin?: ArrayJoinClause;
}

export interface OrderByItem extends NodeBase {
    kind: 'OrderByItem';
    expression: Expression;
    direction?: 'ASC' | 'DESC';
    nulls?: 'FIRST' | 'LAST';
    withFill: boolean;
}

export interface WindowDefinition extends NodeBase {
    kind: 'WindowDefinition';
    name?: Identifier;
    partitionBy: Expression[];
    orderBy: OrderByItem[];
    /** Frame clause text, kept verbatim. */
    frame?: string;
}

export interface SettingAssignment extends NodeBase {
    kind: 'SettingAssignment';
    name: Identifier;
    value?: Expression;
}

export interface Cte extends NodeBase {
    kind: 'Cte';
    name: Identifier;
    /** `WITH x AS (SELECT …)`; absent for the scalar `WITH 1 AS x` form. */
    select?: SelectStatement;
    expression?: Expression;
}

export interface SelectStatement extends NodeBase {
    kind: 'SelectStatement';
    ctes: Cte[];
    distinct: boolean;
    columns: SelectItem[];
    from?: FromClause;
    prewhere?: Expression;
    where?: Expression;
    groupBy: Expression[];
    groupByModifier?: 'WITH TOTALS' | 'WITH ROLLUP' | 'WITH CUBE';
    having?: Expression;
    windows: WindowDefinition[];
    qualify?: Expression;
    orderBy: OrderByItem[];
    limitBy?: { count: Expression; by: Expression[] };
    limit?: Expression;
    offset?: Expression;
    settings: SettingAssignment[];
    format?: Identifier;
    /** `UNION ALL` / `INTERSECT` / `EXCEPT` continuations. */
    setOperations: Array<{ operator: string; select: SelectStatement }>;
}

// ── Statements ───────────────────────────────────────────────────────────────

export interface InsertStatement extends NodeBase {
    kind: 'InsertStatement';
    table?: TableRef;
    columns: Identifier[];
    /** `INSERT … SELECT`. */
    select?: SelectStatement;
    /** Number of `VALUES` tuples, when that form is used. */
    valuesCount?: number;
    settings: SettingAssignment[];
}

export interface ColumnDefinition extends NodeBase {
    kind: 'ColumnDefinition';
    name: Identifier;
    typeText: string;
    defaultKind?: 'DEFAULT' | 'MATERIALIZED' | 'ALIAS' | 'EPHEMERAL';
    defaultExpression?: Expression;
    codec?: string;
    ttl?: Expression;
    comment?: string;
}

export interface CreateTableStatement extends NodeBase {
    kind: 'CreateTableStatement';
    ifNotExists: boolean;
    temporary: boolean;
    table?: TableRef;
    columns: ColumnDefinition[];
    engine?: string;
    orderBy: Expression[];
    partitionBy: Expression[];
    primaryKey: Expression[];
    sampleBy?: Expression;
    ttl?: Expression;
    settings: SettingAssignment[];
    /** `CREATE TABLE … AS SELECT`. */
    select?: SelectStatement;
}

export interface CreateViewStatement extends NodeBase {
    kind: 'CreateViewStatement';
    materialized: boolean;
    ifNotExists: boolean;
    view?: TableRef;
    /** `CREATE MATERIALIZED VIEW … TO target`. */
    to?: TableRef;
    engine?: string;
    populate: boolean;
    select?: SelectStatement;
}

export interface AlterTableStatement extends NodeBase {
    kind: 'AlterTableStatement';
    table?: TableRef;
    /** Command text of each comma-separated action, kept verbatim. */
    actions: string[];
    /** `ALTER TABLE … UPDATE/DELETE … WHERE`. */
    where?: Expression;
}

export interface DropStatement extends NodeBase {
    kind: 'DropStatement';
    what: string;
    ifExists: boolean;
    target?: TableRef;
}

/** Anything the parser recognises as a statement but does not model. */
export interface OtherStatement extends NodeBase {
    kind: 'OtherStatement';
    /** Leading keywords, e.g. `SYSTEM RELOAD DICTIONARIES`. */
    lead: string;
}

export type Statement =
    | SelectStatement
    | InsertStatement
    | CreateTableStatement
    | CreateViewStatement
    | AlterTableStatement
    | DropStatement
    | OtherStatement;

export interface Program extends NodeBase {
    kind: 'Program';
    statements: Statement[];
}

export interface ParseDiagnostic {
    start: number;
    end: number;
    message: string;
}

export interface ParseResult {
    program: Program;
    diagnostics: ParseDiagnostic[];
}

export type Node =
    | Program
    | Statement
    | Expression
    | Cte
    | SelectItem
    | FromClause
    | Join
    | TableRef
    | TableFunctionSource
    | SubquerySource
    | ArrayJoinClause
    | OrderByItem
    | WindowDefinition
    | SettingAssignment
    | ColumnDefinition;

const EXPRESSION_KINDS = new Set<string>([
    'Identifier', 'Qualified', 'NumberLiteral', 'StringLiteral', 'BooleanLiteral', 'NullLiteral',
    'FunctionCall', 'Binary', 'Unary', 'Lambda', 'CaseExpression', 'CastExpression',
    'IntervalExpression', 'Tuple', 'ArrayLiteral', 'Subscript', 'Star', 'SubqueryExpression',
    'Placeholder', 'ErrorExpression',
]);

export function isExpression(node: Node): node is Expression {
    return EXPRESSION_KINDS.has(node.kind);
}

/** Full dotted text of a name, e.g. `db.table`. */
export function nameText(node: NameExpression): string {
    return node.kind === 'Identifier' ? node.name : node.parts.map(p => p.name).join('.');
}
