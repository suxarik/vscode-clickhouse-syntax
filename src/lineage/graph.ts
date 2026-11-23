/**
 * How tables feed each other.
 *
 * A write to one table can quietly become writes to several: a materialized view
 * runs on every insert into its source and writes to a target, a Distributed
 * table forwards to local ones, a Buffer flushes into another. None of that is
 * visible from the table that was written to, which is why a broken view
 * three hops away shows up as inserts failing somewhere that looks fine.
 *
 * This is built from `system.tables` alone. A pipeline that goes through Kafka,
 * a refreshable view's schedule or an external ETL is outside what a server
 * knows about, so what is drawn is the part ClickHouse itself executes.
 */

import { Finding } from '../advice/types';

export type EdgeKind = 'materialized view' | 'distributed' | 'buffer';

export interface TableRow {
    database: string;
    name: string;
    engine: string;
    engineFull: string;
    createQuery: string;
    uuid: string;
    /** Materialized views that run when this table is inserted into. */
    dependents: Array<{ database: string; table: string }>;
}

export interface Edge {
    /** `database.table` the data comes from. */
    from: string;
    /** `database.table` it goes to. */
    to: string;
    kind: EdgeKind;
    /** For a materialized view, the view itself, which sits between the two. */
    via?: string;
}

export interface LineageGraph {
    tables: Map<string, TableRow>;
    edges: Edge[];
    /** Edges whose far end is not a table on this server. */
    dangling: Edge[];
}

export const qualify = (database: string, table: string): string => `${database}.${table}`;

/** A name as ClickHouse prints it: bare, or in backticks when it needs them. */
const NAME = '(?:`(?:[^`\\\\]|\\\\.)*`|[A-Za-z_][A-Za-z0-9_]*)';

function unquote(part: string): string {
    return part.startsWith('`') ? part.slice(1, -1).replace(/\\(.)/g, '$1') : part;
}

function splitName(text: string, defaultDatabase: string): { database: string; table: string } {
    const match = new RegExp(`^(${NAME})(?:\\.(${NAME}))?$`).exec(text.trim());
    if (!match) return { database: defaultDatabase, table: text.trim() };
    return match[2]
        ? { database: unquote(match[1]), table: unquote(match[2]) }
        : { database: defaultDatabase, table: unquote(match[1]) };
}

/**
 * Where a `TO` view writes, read from its definition.
 *
 * `undefined` means the view has no `TO` and keeps its own inner table.
 */
export function viewTarget(createQuery: string, ownDatabase: string): { database: string; table: string } | undefined {
    const header = new RegExp(
        `^\\s*CREATE\\s+MATERIALIZED\\s+VIEW\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${NAME}(?:\\.${NAME})?` +
            `(?:\\s+UUID\\s+'[^']*')?(?:\\s+ON\\s+CLUSTER\\s+\\S+)?\\s+TO\\s+(${NAME}(?:\\.${NAME})?)`,
        'i'
    ).exec(createQuery);
    return header ? splitName(header[1], ownDatabase) : undefined;
}

/** The leading arguments of an engine such as `Distributed('c', 'db', 'tbl', rand())`. */
export function engineArguments(engineFull: string, ownDatabase: string): string[] | undefined {
    const match = /^\s*(Distributed|Buffer)\s*\(/.exec(engineFull);
    if (!match) return undefined;
    const rest = engineFull.slice(match[0].length).replace(/currentDatabase\(\)/g, `'${ownDatabase}'`);
    const found: string[] = [];
    const token = /\s*(?:'((?:[^'\\]|\\.)*)'|([A-Za-z0-9_.]+))\s*(?:,|\))/y;
    for (;;) {
        const next = token.exec(rest);
        if (!next) break;
        found.push(next[1] !== undefined ? next[1].replace(/\\(.)/g, '$1') : next[2]);
        if (rest[token.lastIndex - 1] === ')') break;
    }
    return found;
}

export function buildGraph(rows: TableRow[]): LineageGraph {
    const tables = new Map(rows.map(row => [qualify(row.database, row.name), row]));
    const edges: Edge[] = [];

    for (const row of rows) {
        const own = qualify(row.database, row.name);

        if (row.engine === 'MaterializedView') {
            // The view's output goes to its TO table, or to the table it made
            // for itself, which is named after the view or after its uuid.
            let target = viewTarget(row.createQuery, row.database);
            if (!target) {
                const inner =
                    tables.get(qualify(row.database, `.inner_id.${row.uuid}`)) ??
                    tables.get(qualify(row.database, `.inner.${row.name}`));
                target = inner ? { database: inner.database, table: inner.name } : undefined;
            }
            if (target) {
                const to = qualify(target.database, target.table);
                // The source side is recorded on the source table, below; here
                // only the view's own output is added.
                edges.push({ from: own, to, kind: 'materialized view', via: own });
            }
            continue;
        }

        if (row.engine === 'Distributed' || row.engine === 'Buffer') {
            const args = engineArguments(row.engineFull, row.database);
            // Distributed is (cluster, database, table, …); Buffer is (database, table, …).
            const at = row.engine === 'Distributed' ? 1 : 0;
            if (args && args.length > at + 1) {
                edges.push({
                    from: own,
                    to: qualify(args[at], args[at + 1]),
                    kind: row.engine === 'Distributed' ? 'distributed' : 'buffer',
                });
            }
        }
    }

    // A source feeds a view, and the view feeds its target. Treating the view as
    // a table of its own keeps the picture honest: it is a place a query can fail.
    for (const row of rows) {
        const source = qualify(row.database, row.name);
        for (const dependent of row.dependents) {
            const view = qualify(dependent.database, dependent.table);
            if (tables.get(view)?.engine === 'MaterializedView') {
                edges.push({ from: source, to: view, kind: 'materialized view', via: view });
            }
        }
    }

    const dangling = edges.filter(edge => !tables.has(edge.to));
    return { tables, edges, dangling };
}

export interface LineageNode {
    name: string;
    /** Absent when the table is not on this server. */
    row?: TableRow;
    /** How it is reached from its parent. */
    kind?: EdgeKind;
    children: LineageNode[];
    /** Already drawn higher up, so not followed again. */
    cycle?: boolean;
}

/** Hops past which a picture stops being one. */
const MAX_DEPTH = 8;

function walk(
    graph: LineageGraph,
    name: string,
    direction: 'down' | 'up',
    seen: Set<string>,
    kind?: EdgeKind,
    depth = 0
): LineageNode {
    const node: LineageNode = { name, row: graph.tables.get(name), kind, children: [] };
    if (seen.has(name)) return { ...node, cycle: true };
    if (depth >= MAX_DEPTH) return node;
    const next = new Set(seen).add(name);

    const edges = graph.edges.filter(edge => (direction === 'down' ? edge.from === name : edge.to === name));
    for (const edge of edges) {
        const other = direction === 'down' ? edge.to : edge.from;
        node.children.push(walk(graph, other, direction, next, edge.kind, depth + 1));
    }
    return node;
}

/** What feeds `name`, and what `name` feeds. */
export function lineageOf(graph: LineageGraph, name: string): { upstream: LineageNode; downstream: LineageNode } {
    return { upstream: walk(graph, name, 'up', new Set()), downstream: walk(graph, name, 'down', new Set()) };
}

/** Tables that take part in at least one pipeline, for choosing where to start. */
export function connectedTables(graph: LineageGraph): string[] {
    const names = new Set<string>();
    for (const edge of graph.edges) {
        if (graph.tables.has(edge.from)) names.add(edge.from);
        if (graph.tables.has(edge.to)) names.add(edge.to);
    }
    return [...names].sort();
}

/** A table with this many views runs all of them on every insert. */
const MANY_VIEWS = 5;

/**
 * What is wrong with the pipeline around `focus`.
 *
 * Only what is reachable from it, up or down: a missing table elsewhere on the
 * server is a real problem but not the one being looked at.
 */
export function lineageFindings(graph: LineageGraph, focus: string): Finding[] {
    const { upstream, downstream } = lineageOf(graph, focus);
    const reachable = new Set<string>();
    const collect = (node: LineageNode): void => {
        reachable.add(node.name);
        node.children.forEach(collect);
    };
    collect(upstream);
    collect(downstream);

    const findings: Finding[] = [];
    for (const edge of graph.dangling) {
        if (!reachable.has(edge.from) && !reachable.has(edge.to)) continue;
        const what =
            edge.kind === 'materialized view'
                ? `The view ${edge.from} writes to ${edge.to}`
                : `${edge.from} forwards to ${edge.to}`;
        findings.push({
            ruleId: 'target-missing',
            importance: 'high',
            title: `${edge.to} does not exist`,
            evidence: `${what}, and there is no such table on this server.`,
            suggestion:
                edge.kind === 'materialized view'
                    ? "Every insert into the view's source runs the view and fails on the write, so inserts to the " +
                      'source fail too. Create the target, or drop the view.'
                    : 'Reads and writes through this table fail. Create the table it points at, or recreate this one.',
            subject: { kind: 'table', name: edge.to },
        });
    }

    const views = graph.edges.filter(edge => edge.from === focus && edge.kind === 'materialized view');
    if (views.length >= MANY_VIEWS) {
        findings.push({
            ruleId: 'many-views',
            importance: 'low',
            title: `${focus} runs ${views.length} materialized views on every insert`,
            evidence: views.map(edge => edge.to).join(', '),
            suggestion:
                'Each one reads the inserted block and writes its own, so an insert costs the sum of all of them. ' +
                'That is fine until inserts get slow; then this is the first place to look.',
            subject: { kind: 'table', name: focus },
        });
    }
    return findings;
}
