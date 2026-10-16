/**
 * What several analysed queries had in common.
 *
 * This is the only part of the advice that remembers anything, which makes what
 * it remembers the thing to get right. It keeps column *names*, a pruning
 * fraction and a row count — never the query, never a literal, never a result.
 * A tool that quietly accumulated a history of production queries would be
 * indefensible, and the shape stored here makes that impossible rather than
 * merely discouraged.
 */
import { Expression, Program } from '../parser/ast';
import { allSelects } from '../parser/walk';

export interface Observation {
    /** Epoch milliseconds, so stale observations can be dropped. */
    at: number;
    /** `database.table`, as the plan named it. */
    table: string;
    /** How much the index removed, 0 for nothing. */
    prunedFraction: number;
    rowsRead: number;
    /** Column names only. */
    filteredColumns: string[];
}

export interface SchemaAdvice {
    table: string;
    column: string;
    /** How many analysed queries filtered on it without pruning. */
    queries: number;
    sortingKey: string;
    ddl: string;
    note: string;
}

/** Columns a comparison constrains, which is not the same as columns mentioned. */
function columnsConstrainedBy(expression: Expression | undefined, into: Set<string>): void {
    if (!expression) return;

    if (expression.kind === 'Binary') {
        // `a = b` between two columns is a join condition: it relates them
        // rather than narrowing either, and cannot prune a primary key.
        const left = expression.left;
        const right = expression.right;
        const bothColumns =
            (left.kind === 'Identifier' || left.kind === 'Qualified') &&
            (right.kind === 'Identifier' || right.kind === 'Qualified');

        if (!bothColumns) {
            for (const side of [left, right]) {
                if (side.kind === 'Identifier') into.add(side.name);
                else if (side.kind === 'Qualified') into.add(side.parts[side.parts.length - 1].name);
            }
        }
        columnsConstrainedBy(left, into);
        columnsConstrainedBy(right, into);
        return;
    }

    if (expression.kind === 'Unary') columnsConstrainedBy(expression.operand, into);
    if (expression.kind === 'FunctionCall') for (const arg of expression.args) columnsConstrainedBy(arg, into);
}

/** The columns this query narrows, from WHERE and PREWHERE only. */
export function filteredColumns(program: Program): string[] {
    const found = new Set<string>();
    for (const select of allSelects(program)) {
        columnsConstrainedBy(select.where, found);
        columnsConstrainedBy(select.prewhere, found);
    }
    return [...found];
}

export function observe(input: {
    table: string;
    prunedFraction: number;
    rowsRead: number;
    program: Program;
}): Observation {
    return {
        at: Date.now(),
        table: input.table,
        prunedFraction: input.prunedFraction,
        rowsRead: input.rowsRead,
        filteredColumns: filteredColumns(input.program),
    };
}

/** One query proves nothing; a habit is worth advising on. */
const ENOUGH_QUERIES = 2;
/** Above this, the index is working and there is nothing to say. */
const PRUNING_IS_FINE = 0.25;

export function summariseTable(
    table: string,
    observations: Observation[],
    sortingKey: string,
    /**
     * The table's own columns.
     *
     * A join puts another table's filters in the same query, and the filtered
     * columns are collected per query rather than per table. Without this, a
     * query reading orders and joining users suggests an index on
     * `users.status` — a column users does not have, producing DDL that fails.
     */
    columns?: string[]
): SchemaAdvice | undefined {
    const poor = observations.filter(
        observation => observation.table === table && observation.prunedFraction <= PRUNING_IS_FINE
    );
    if (poor.length < ENOUGH_QUERIES) return undefined;

    const leads = sortingKey.split(',')[0]?.trim().toLowerCase() ?? '';
    const known = columns && new Set(columns.map(name => name.toLowerCase()));
    const counts = new Map<string, number>();
    for (const observation of poor) {
        for (const column of observation.filteredColumns) {
            if (column.toLowerCase() === leads) continue;
            if (known && !known.has(column.toLowerCase())) continue;
            counts.set(column, (counts.get(column) ?? 0) + 1);
        }
    }

    const [column, queries] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
    if (!column || queries < ENOUGH_QUERIES) return undefined;

    return {
        table,
        column,
        queries,
        sortingKey,
        ddl:
            `-- ${queries} analysed queries filtered ${table} on ${column}, and the index removed nothing.\n` +
            `-- The key leads with ${leads || '(none)'}, which none of them narrowed.\n` +
            `ALTER TABLE ${table}\n` +
            `    ADD INDEX ${column}_idx ${column} TYPE set(0) GRANULARITY 4;\n` +
            `\n-- Or lead the key with it, which reads less but rewrites the table:\n` +
            `-- ORDER BY (${column}, ${sortingKey})`,
        note:
            'A skip index can be added in place and filled with MATERIALIZE INDEX. ' +
            'Changing the sorting key rewrites the table, so it is a migration rather than an edit.',
    };
}

// ── Keeping them ────────────────────────────────────────────────────────────

/** Enough to see a habit, not enough to be a history. */
const KEEP_AT_MOST = 300;
/** A table's shape changes; last month's observations are not evidence. */
const KEEP_FOR_DAYS = 30;

export interface ObservationMemento {
    get<T>(key: string, fallback: T): T;
    update(key: string, value: unknown): Thenable<void>;
}

const STORAGE_KEY = 'clickhouse.advice.observations';

/**
 * Observations live in the extension's own storage, not in settings: they are
 * data rather than configuration, so they must not sync between machines or
 * find their way into a repository.
 */
export class ObservationStore {
    constructor(private readonly memento: ObservationMemento) {}

    all(): Observation[] {
        const cutoff = Date.now() - KEEP_FOR_DAYS * 24 * 60 * 60 * 1000;
        return this.memento.get<Observation[]>(STORAGE_KEY, []).filter(entry => entry.at >= cutoff);
    }

    async record(observations: Observation[]): Promise<void> {
        if (observations.length === 0) return;
        const kept = [...this.all(), ...observations].slice(-KEEP_AT_MOST);
        await this.memento.update(STORAGE_KEY, kept);
    }

    async forget(): Promise<void> {
        await this.memento.update(STORAGE_KEY, []);
    }

    /** Tables seen often enough to be worth asking the server about. */
    tables(): string[] {
        const counts = new Map<string, number>();
        for (const entry of this.all()) counts.set(entry.table, (counts.get(entry.table) ?? 0) + 1);
        return [...counts.entries()].filter(([, count]) => count >= ENOUGH_QUERIES).map(([table]) => table);
    }
}
