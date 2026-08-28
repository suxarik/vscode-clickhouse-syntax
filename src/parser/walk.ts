/**
 * Generic traversal over the parse tree.
 */
import {
    Expression,
    Node,
    Program,
    SelectStatement,
    Statement,
    TableSource,
} from './ast';

export type Visitor = (node: Node, parent: Node | undefined) => void | false;

/** Depth-first walk. Returning `false` from the visitor skips a node's children. */
export function walk(node: Node, visit: Visitor, parent?: Node): void {
    if (visit(node, parent) === false) return;
    for (const child of childrenOf(node)) walk(child, visit, node);
}

export function childrenOf(node: Node): Node[] {
    const children: Node[] = [];
    const push = (child: Node | undefined) => {
        if (child) children.push(child);
    };
    const pushAll = (list: Node[] | undefined) => {
        if (list) children.push(...list);
    };

    switch (node.kind) {
        case 'Program':
            pushAll(node.statements);
            break;
        case 'SelectStatement':
            pushAll(node.ctes);
            pushAll(node.columns);
            push(node.from);
            push(node.prewhere);
            push(node.where);
            pushAll(node.groupBy);
            push(node.having);
            pushAll(node.windows);
            push(node.qualify);
            pushAll(node.orderBy);
            if (node.limitBy) {
                push(node.limitBy.count);
                pushAll(node.limitBy.by);
            }
            push(node.limit);
            push(node.offset);
            pushAll(node.settings);
            for (const operation of node.setOperations) push(operation.select);
            break;
        case 'InsertStatement':
            push(node.table);
            pushAll(node.columns);
            pushAll(node.settings);
            push(node.select);
            break;
        case 'CreateTableStatement':
            push(node.table);
            pushAll(node.columns);
            pushAll(node.orderBy);
            pushAll(node.partitionBy);
            pushAll(node.primaryKey);
            push(node.sampleBy);
            push(node.ttl);
            pushAll(node.settings);
            push(node.select);
            break;
        case 'CreateViewStatement':
            push(node.view);
            push(node.to);
            push(node.select);
            break;
        case 'AlterTableStatement':
            push(node.table);
            push(node.where);
            break;
        case 'DropStatement':
            push(node.target);
            break;
        case 'Cte':
            push(node.name);
            push(node.select);
            push(node.expression);
            break;
        case 'SelectItem':
            push(node.expression);
            push(node.alias);
            break;
        case 'FromClause':
            push(node.source);
            pushAll(node.joins);
            push(node.arrayJoin);
            break;
        case 'Join':
            push(node.source);
            push(node.on);
            pushAll(node.using);
            break;
        case 'TableRef':
            push(node.database);
            push(node.table);
            push(node.alias);
            break;
        case 'TableFunctionSource':
            push(node.call);
            push(node.alias);
            break;
        case 'SubquerySource':
            push(node.select);
            push(node.alias);
            break;
        case 'ArrayJoinClause':
            pushAll(node.items);
            break;
        case 'OrderByItem':
            push(node.expression);
            break;
        case 'WindowDefinition':
            push(node.name);
            pushAll(node.partitionBy);
            pushAll(node.orderBy);
            break;
        case 'SettingAssignment':
            push(node.name);
            push(node.value);
            break;
        case 'ColumnDefinition':
            push(node.name);
            push(node.defaultExpression);
            push(node.ttl);
            break;
        case 'Qualified':
            pushAll(node.parts);
            break;
        case 'FunctionCall':
            pushAll(node.parameters);
            pushAll(node.args);
            if (node.over) push(node.over);
            break;
        case 'Binary':
            push(node.left);
            push(node.right);
            break;
        case 'Unary':
            push(node.operand);
            break;
        case 'Lambda':
            pushAll(node.params);
            push(node.body);
            break;
        case 'CaseExpression':
            push(node.subject);
            for (const branch of node.branches) {
                push(branch.when);
                push(branch.then);
            }
            push(node.else);
            break;
        case 'CastExpression':
            push(node.value);
            break;
        case 'IntervalExpression':
            push(node.value);
            break;
        case 'Tuple':
        case 'ArrayLiteral':
            pushAll(node.items);
            break;
        case 'Subscript':
            push(node.target);
            push(node.index);
            break;
        case 'Star':
            push(node.qualifier);
            pushAll(node.except);
            break;
        case 'SubqueryExpression':
            push(node.select);
            break;
        default:
            break;
    }
    return children;
}

/** Innermost node containing `offset`, plus the chain of its ancestors. */
export function nodePathAt(root: Node, offset: number): Node[] {
    const path: Node[] = [];
    let current: Node | undefined = root;
    while (current) {
        path.push(current);
        current = childrenOf(current).find(child => offset >= child.start && offset <= child.end);
    }
    return path;
}

/** Every SELECT in a program, outermost first. */
export function allSelects(program: Program): SelectStatement[] {
    const selects: SelectStatement[] = [];
    walk(program, node => {
        if (node.kind === 'SelectStatement') selects.push(node);
    });
    return selects;
}

/** Every expression node inside a node. */
export function allExpressions(node: Node): Expression[] {
    const expressions: Expression[] = [];
    walk(node, child => {
        if (isExpressionNode(child)) expressions.push(child);
    });
    return expressions;
}

const EXPRESSION_KINDS = new Set<string>([
    'Identifier', 'Qualified', 'NumberLiteral', 'StringLiteral', 'BooleanLiteral', 'NullLiteral',
    'FunctionCall', 'Binary', 'Unary', 'Lambda', 'CaseExpression', 'CastExpression',
    'IntervalExpression', 'Tuple', 'ArrayLiteral', 'Subscript', 'Star', 'SubqueryExpression',
    'Placeholder', 'ErrorExpression',
]);

function isExpressionNode(node: Node): node is Expression {
    return EXPRESSION_KINDS.has(node.kind);
}

/** The table sources of a FROM clause, source first. */
export function sourcesOf(select: SelectStatement): TableSource[] {
    if (!select.from) return [];
    const sources: TableSource[] = [];
    if (select.from.source) sources.push(select.from.source);
    for (const join of select.from.joins) sources.push(join.source);
    return sources;
}

/** Statement containing `offset`. */
export function statementAt(program: Program, offset: number): Statement | undefined {
    return program.statements.find(statement => offset >= statement.start && offset <= statement.end);
}
