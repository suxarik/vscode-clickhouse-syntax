/**
 * Scope analysis over the parse tree.
 *
 * The binder answers the questions every language feature needs: which tables
 * are visible here, what does this alias refer to, is this identifier a column,
 * a lambda parameter or a select alias. Column knowledge is injected through
 * `ColumnSource` so the binder stays independent of the schema and catalog.
 */
import {
    ArrayJoinClause,
    Cte,
    Expression,
    FromClause,
    Program,
    SelectStatement,
    Statement,
    TableSource,
    WindowDefinition,
} from './ast';

/** Supplies the column names of a known table. */
export interface ColumnSource {
    /** Column names, or undefined when the table is unknown. */
    columnsOf(table: string, database?: string): string[] | undefined;
    /**
     * What `{{ ref('x') }}` or `{{ source('a','b') }}` points at, when a dbt
     * manifest says. Optional: without one a tag simply stays opaque.
     */
    resolveTemplate?(call: 'ref' | 'source', args: string[]): { database?: string; table: string } | undefined;
}

export type BoundTableKind = 'table' | 'cte' | 'subquery' | 'tableFunction';

export interface BoundTable {
    /** The name that qualifies its columns: the alias when there is one. */
    label: string;
    kind: BoundTableKind;
    database?: string;
    /** Underlying table name; absent for subqueries. */
    table?: string;
    alias?: string;
    /** Known column names, or undefined when they cannot be determined. */
    columns?: string[];
    final: boolean;
    node: TableSource;
    start: number;
    end: number;
}

export type ScopeKind = 'query' | 'lambda';

export interface Scope {
    id: number;
    kind: ScopeKind;
    parent?: Scope;
    children: Scope[];
    /** Tables from this scope's FROM clause. */
    tables: BoundTable[];
    /** CTE names bound at this level. */
    ctes: Map<string, Cte>;
    /** SELECT-list aliases, usable from GROUP BY / HAVING / ORDER BY. */
    aliases: Map<string, Expression>;
    /** Names introduced by ARRAY JOIN. */
    arrayJoinAliases: Set<string>;
    /** Lambda parameter names. */
    lambdaParams: Set<string>;
    /** Named windows declared in a WINDOW clause. */
    windows: Set<string>;
    select?: SelectStatement;
    /**
     * True for a scope that cannot see the enclosing query's tables: a FROM
     * subquery and a CTE body are evaluated independently of the query that uses
     * them. A correlated subquery in WHERE is not isolated, and neither is a
     * lambda, since both run inside the enclosing query.
     */
    isolated: boolean;
    start: number;
    end: number;
}

export type ReferenceKind = 'column' | 'table' | 'function' | 'setting' | 'window';

export interface Reference {
    kind: ReferenceKind;
    name: string;
    /** Qualifier of a dotted reference, e.g. `e` in `e.user_id`. */
    qualifier?: string;
    /** Database qualifier of a table reference. */
    database?: string;
    start: number;
    end: number;
    scope: Scope;
}

export interface BindResult {
    scopes: Scope[];
    references: Reference[];
}

/** How an identifier resolved. */
export type Resolution =
    | { kind: 'lambdaParam' }
    | { kind: 'arrayJoin' }
    | { kind: 'column'; tables: BoundTable[] }
    | { kind: 'alias' }
    | { kind: 'unknownQualifier' }
    | { kind: 'unknown' }
    | { kind: 'indeterminate' };

const NO_COLUMNS: ColumnSource = { columnsOf: () => undefined };

class Binder {
    private readonly scopes: Scope[] = [];
    private readonly references: Reference[] = [];
    private nextId = 0;

    constructor(private readonly columnSource: ColumnSource) {}

    bind(program: Program): BindResult {
        for (const statement of program.statements) this.bindStatement(statement, undefined);
        return { scopes: this.scopes, references: this.references };
    }

    private createScope(
        kind: ScopeKind,
        parent: Scope | undefined,
        start: number,
        end: number,
        isolated = false
    ): Scope {
        const scope: Scope = {
            id: this.nextId++,
            kind,
            parent,
            children: [],
            tables: [],
            ctes: new Map(),
            aliases: new Map(),
            arrayJoinAliases: new Set(),
            lambdaParams: new Set(),
            windows: new Set(),
            isolated,
            start,
            end,
        };
        if (parent) parent.children.push(scope);
        this.scopes.push(scope);
        return scope;
    }

    private bindStatement(statement: Statement, parent: Scope | undefined): void {
        switch (statement.kind) {
            case 'SelectStatement':
                this.bindSelect(statement, parent);
                break;
            case 'InsertStatement': {
                const scope = this.createScope('query', parent, statement.start, statement.end);
                if (statement.table) this.recordTableReference(statement.table, scope);
                for (const setting of statement.settings) {
                    this.references.push({
                        kind: 'setting',
                        name: setting.name.name,
                        start: setting.name.start,
                        end: setting.name.end,
                        scope,
                    });
                }
                if (statement.select) this.bindSelect(statement.select, parent);
                break;
            }
            case 'CreateTableStatement': {
                const scope = this.createScope('query', parent, statement.start, statement.end);
                if (statement.table) this.recordTableReference(statement.table, scope);
                // Column keys reference the table being defined.
                const columns = statement.columns.map(column => column.name.name);
                if (statement.table) {
                    scope.tables.push({
                        label: statement.table.table.name,
                        kind: 'table',
                        table: statement.table.table.name,
                        database: statement.table.database?.name,
                        columns,
                        final: false,
                        node: statement.table,
                        start: statement.table.start,
                        end: statement.table.end,
                    });
                }
                for (const expression of [
                    ...statement.orderBy,
                    ...statement.partitionBy,
                    ...statement.primaryKey,
                    ...(statement.sampleBy ? [statement.sampleBy] : []),
                    ...(statement.ttl ? [statement.ttl] : []),
                ]) {
                    this.bindExpression(expression, scope);
                }
                for (const column of statement.columns) {
                    if (column.defaultExpression) this.bindExpression(column.defaultExpression, scope);
                    if (column.ttl) this.bindExpression(column.ttl, scope);
                }
                for (const setting of statement.settings) {
                    this.references.push({
                        kind: 'setting',
                        name: setting.name.name,
                        start: setting.name.start,
                        end: setting.name.end,
                        scope,
                    });
                }
                if (statement.select) this.bindSelect(statement.select, parent);
                break;
            }
            case 'CreateViewStatement': {
                const scope = this.createScope('query', parent, statement.start, statement.end);
                if (statement.view) this.recordTableReference(statement.view, scope);
                if (statement.to) this.recordTableReference(statement.to, scope);
                if (statement.select) this.bindSelect(statement.select, parent);
                break;
            }
            case 'AlterTableStatement': {
                const scope = this.createScope('query', parent, statement.start, statement.end);
                if (statement.table) {
                    this.recordTableReference(statement.table, scope);
                    scope.tables.push(this.bindTableRefAsTable(statement.table));
                }
                if (statement.where) this.bindExpression(statement.where, scope);
                break;
            }
            case 'DropStatement': {
                const scope = this.createScope('query', parent, statement.start, statement.end);
                if (statement.target) this.recordTableReference(statement.target, scope);
                break;
            }
            default:
                this.createScope('query', parent, statement.start, statement.end);
                break;
        }
    }

    private bindSelect(select: SelectStatement, parent: Scope | undefined, isolated = false): Scope {
        const scope = this.createScope('query', parent, select.start, select.end, isolated);
        scope.select = select;

        // CTEs bind before the body, and each is visible to the ones after it.
        for (const cte of select.ctes) {
            scope.ctes.set(cte.name.name.toLowerCase(), cte);
            if (cte.select) this.bindSelect(cte.select, scope, true);
            else if (cte.expression) this.bindExpression(cte.expression, scope);
        }

        if (select.from) this.bindFrom(select.from, scope);

        for (const item of select.columns) {
            if (item.alias) scope.aliases.set(item.alias.name.toLowerCase(), item.expression);
        }
        for (const window of select.windows) {
            if (window.name) scope.windows.add(window.name.name.toLowerCase());
            this.bindWindow(window, scope);
        }

        for (const item of select.columns) this.bindExpression(item.expression, scope);
        if (select.prewhere) this.bindExpression(select.prewhere, scope);
        if (select.where) this.bindExpression(select.where, scope);
        for (const expression of select.groupBy) this.bindExpression(expression, scope);
        if (select.having) this.bindExpression(select.having, scope);
        if (select.qualify) this.bindExpression(select.qualify, scope);
        for (const item of select.orderBy) this.bindExpression(item.expression, scope);
        if (select.limitBy) {
            this.bindExpression(select.limitBy.count, scope);
            for (const expression of select.limitBy.by) this.bindExpression(expression, scope);
        }
        if (select.limit) this.bindExpression(select.limit, scope);
        if (select.offset) this.bindExpression(select.offset, scope);
        for (const setting of select.settings) {
            this.references.push({
                kind: 'setting',
                name: setting.name.name,
                start: setting.name.start,
                end: setting.name.end,
                scope,
            });
        }

        for (const operation of select.setOperations) this.bindSelect(operation.select, parent);

        return scope;
    }

    private bindFrom(from: FromClause, scope: Scope): void {
        if (from.source) scope.tables.push(this.bindSource(from.source, scope));
        for (const join of from.joins) {
            scope.tables.push(this.bindSource(join.source, scope));
            if (join.on) this.bindExpression(join.on, scope);
        }
        if (from.arrayJoin) this.bindArrayJoin(from.arrayJoin, scope);
    }

    private bindArrayJoin(arrayJoin: ArrayJoinClause, scope: Scope): void {
        for (const item of arrayJoin.items) {
            this.bindExpression(item.expression, scope);
            const name = item.alias?.name ?? (item.expression.kind === 'Identifier' ? item.expression.name : undefined);
            if (name) scope.arrayJoinAliases.add(name.toLowerCase());
        }
    }

    private bindWindow(window: WindowDefinition, scope: Scope): void {
        for (const expression of window.partitionBy) this.bindExpression(expression, scope);
        for (const item of window.orderBy) this.bindExpression(item.expression, scope);
    }

    private bindTableRefAsTable(ref: import('./ast').TableRef): BoundTable {
        // A dbt tag names a relation the manifest can resolve; if it cannot,
        // the table stays unknown rather than being invented.
        const resolved = this.resolveTemplateRef(ref);
        const table = resolved?.table ?? ref.table.name;
        const database = resolved?.database ?? ref.database?.name;

        return {
            label: ref.alias?.name ?? ref.table.name,
            kind: 'table',
            table,
            database,
            alias: ref.alias?.name,
            columns: this.columnSource.columnsOf(table, database),
            final: ref.final,
            node: ref,
            start: ref.start,
            end: ref.end,
        };
    }

    private resolveTemplateRef(
        ref: import('./ast').TableRef
    ): { database?: string; table: string } | undefined {
        const template = ref.template;
        if (!template?.call || !template.arguments) return undefined;
        return this.columnSource.resolveTemplate?.(template.call, template.arguments);
    }

    private bindSource(source: TableSource, scope: Scope): BoundTable {
        if (source.kind === 'TableRef') {
            this.recordTableReference(source, scope);
            const cte = this.lookupCte(scope, source.table.name);
            if (cte && !source.database) {
                return {
                    label: source.alias?.name ?? source.table.name,
                    kind: 'cte',
                    table: source.table.name,
                    alias: source.alias?.name,
                    columns: projectionOf(cte.select),
                    final: source.final,
                    node: source,
                    start: source.start,
                    end: source.end,
                };
            }
            return this.bindTableRefAsTable(source);
        }

        if (source.kind === 'SubquerySource') {
            this.bindSelect(source.select, scope, true);
            return {
                label: source.alias?.name ?? '',
                kind: 'subquery',
                alias: source.alias?.name,
                columns: projectionOf(source.select),
                final: false,
                node: source,
                start: source.start,
                end: source.end,
            };
        }

        this.bindExpression(source.call, scope);
        return {
            label: source.alias?.name ?? source.call.name,
            kind: 'tableFunction',
            table: source.call.name,
            alias: source.alias?.name,
            final: false,
            node: source,
            start: source.start,
            end: source.end,
        };
    }

    private recordTableReference(ref: import('./ast').TableRef, scope: Scope): void {
        const reference: Reference = {
            kind: 'table',
            name: ref.table.name,
            start: ref.table.start,
            end: ref.table.end,
            scope,
        };
        if (ref.database) reference.database = ref.database.name;
        this.references.push(reference);
    }

    private lookupCte(scope: Scope | undefined, name: string): Cte | undefined {
        const key = name.toLowerCase();
        for (let current = scope; current; current = current.parent) {
            const cte = current.ctes.get(key);
            if (cte) return cte;
        }
        return undefined;
    }

    private bindExpression(expression: Expression, scope: Scope): void {
        switch (expression.kind) {
            case 'Identifier':
                this.references.push({
                    kind: 'column',
                    name: expression.name,
                    start: expression.start,
                    end: expression.end,
                    scope,
                });
                break;
            case 'Qualified': {
                const parts = expression.parts;
                const last = parts[parts.length - 1];
                const reference: Reference = {
                    kind: 'column',
                    name: last.name,
                    qualifier: parts[parts.length - 2]?.name,
                    start: expression.start,
                    end: expression.end,
                    scope,
                };
                if (parts.length > 2) reference.database = parts[parts.length - 3].name;
                this.references.push(reference);
                break;
            }
            case 'FunctionCall': {
                this.references.push({
                    kind: 'function',
                    name: expression.name,
                    start: expression.nameStart,
                    end: expression.nameEnd,
                    scope,
                });
                for (const parameter of expression.parameters ?? []) this.bindExpression(parameter, scope);
                for (const argument of expression.args) this.bindExpression(argument, scope);
                if (expression.over) {
                    if (expression.over.kind === 'WindowDefinition') this.bindWindow(expression.over, scope);
                    else {
                        this.references.push({
                            kind: 'window',
                            name: expression.over.name,
                            start: expression.over.start,
                            end: expression.over.end,
                            scope,
                        });
                    }
                }
                break;
            }
            case 'Binary':
                this.bindExpression(expression.left, scope);
                this.bindExpression(expression.right, scope);
                break;
            case 'Unary':
                this.bindExpression(expression.operand, scope);
                break;
            case 'Lambda': {
                // Lambda parameters shadow columns inside the body only.
                const inner = this.createScope('lambda', scope, expression.start, expression.end);
                for (const param of expression.params) inner.lambdaParams.add(param.name.toLowerCase());
                this.bindExpression(expression.body, inner);
                break;
            }
            case 'CaseExpression':
                if (expression.subject) this.bindExpression(expression.subject, scope);
                for (const branch of expression.branches) {
                    this.bindExpression(branch.when, scope);
                    this.bindExpression(branch.then, scope);
                }
                if (expression.else) this.bindExpression(expression.else, scope);
                break;
            case 'CastExpression':
                this.bindExpression(expression.value, scope);
                break;
            case 'IntervalExpression':
                this.bindExpression(expression.value, scope);
                break;
            case 'Tuple':
            case 'ArrayLiteral':
                for (const item of expression.items) this.bindExpression(item, scope);
                break;
            case 'Subscript':
                this.bindExpression(expression.target, scope);
                this.bindExpression(expression.index, scope);
                break;
            case 'SubqueryExpression':
                this.bindSelect(expression.select, scope);
                break;
            default:
                break;
        }
    }
}

/**
 * Column names a SELECT projects, or undefined when they cannot all be named
 * (a `*`, or an expression with no alias).
 */
export function projectionOf(select: SelectStatement | undefined): string[] | undefined {
    if (!select) return undefined;
    const names: string[] = [];
    for (const item of select.columns) {
        if (item.alias) {
            names.push(item.alias.name);
            continue;
        }
        const expression = item.expression;
        if (expression.kind === 'Identifier') {
            names.push(expression.name);
            continue;
        }
        if (expression.kind === 'Qualified') {
            names.push(expression.parts[expression.parts.length - 1].name);
            continue;
        }
        // A star or an unaliased expression makes the projection unknowable.
        return undefined;
    }
    return names;
}

export function bind(program: Program, columnSource: ColumnSource = NO_COLUMNS): BindResult {
    return new Binder(columnSource).bind(program);
}

/**
 * Innermost scope containing `offset`.
 *
 * A cursor just past the last token — which is where it sits while someone is
 * still typing — falls back to the most recently opened scope before it, so
 * completion still has a scope to work with.
 */
export function scopeAt(result: BindResult, offset: number): Scope | undefined {
    let containing: Scope | undefined;
    let preceding: Scope | undefined;

    for (const scope of result.scopes) {
        if (offset >= scope.start && offset <= scope.end) {
            if (!containing || scope.start >= containing.start) containing = scope;
        } else if (scope.start <= offset) {
            if (!preceding || scope.start >= preceding.start) preceding = scope;
        }
    }
    return containing ?? preceding;
}

/**
 * Scopes to consult for name resolution, innermost first, stopping at the first
 * isolation boundary.
 */
function resolutionChain(scope: Scope | undefined): Scope[] {
    const chain: Scope[] = [];
    for (let current = scope; current; current = current.parent) {
        chain.push(current);
        if (current.isolated) break;
    }
    return chain;
}

/** Tables visible from a scope, walking outwards through enclosing queries. */
export function visibleTables(scope: Scope | undefined): BoundTable[] {
    return resolutionChain(scope).flatMap(current => current.tables);
}

/** CTE names visible from a scope. */
export function visibleCtes(scope: Scope | undefined): Cte[] {
    const ctes: Cte[] = [];
    for (let current = scope; current; current = current.parent) {
        ctes.push(...current.ctes.values());
    }
    return ctes;
}

/** Resolve a bare or qualified identifier against a scope. */
export function resolveName(scope: Scope | undefined, name: string, qualifier?: string): Resolution {
    if (!scope) return { kind: 'indeterminate' };
    const lower = name.toLowerCase();

    if (qualifier) {
        const qualifierLower = qualifier.toLowerCase();
        const matches = visibleTables(scope).filter(
            table => table.label.toLowerCase() === qualifierLower || table.table?.toLowerCase() === qualifierLower
        );
        if (matches.length === 0) {
            // The qualifier may be an ARRAY JOIN alias or a lambda parameter holding a tuple.
            for (const current of resolutionChain(scope)) {
                if (current.lambdaParams.has(qualifierLower)) return { kind: 'lambdaParam' };
                if (current.arrayJoinAliases.has(qualifierLower)) return { kind: 'arrayJoin' };
            }
            return { kind: 'unknownQualifier' };
        }
        const known = matches.filter(table => table.columns);
        if (known.length === 0) return { kind: 'indeterminate' };
        const holding = known.filter(table => table.columns!.some(column => column.toLowerCase() === lower));
        if (holding.length === 0) return { kind: 'unknown' };
        return { kind: 'column', tables: holding };
    }

    for (const current of resolutionChain(scope)) {
        if (current.lambdaParams.has(lower)) return { kind: 'lambdaParam' };
        if (current.arrayJoinAliases.has(lower)) return { kind: 'arrayJoin' };
    }

    const tables = visibleTables(scope);
    const holding = tables.filter(table => table.columns?.some(column => column.toLowerCase() === lower));
    if (holding.length > 0) return { kind: 'column', tables: holding };

    for (const current of resolutionChain(scope)) {
        if (current.aliases.has(lower)) return { kind: 'alias' };
    }

    // Unknown only when every visible table's columns are known.
    if (tables.length > 0 && tables.every(table => table.columns)) return { kind: 'unknown' };
    return { kind: 'indeterminate' };
}
