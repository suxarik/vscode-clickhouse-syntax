/**
 * Reading a ClickHouse query plan.
 *
 * `EXPLAIN` returns indented text, which is a tree in disguise. Turning it back
 * into one lets the parts-pruning and granule numbers - the reason anyone reads
 * a plan in the first place - be pulled out and put at the top.
 */

export interface PlanNode {
    text: string;
    depth: number;
    children: PlanNode[];
}

/** Index usage for one table, as `EXPLAIN indexes = 1` reports it. */
export interface IndexUsage {
    table?: string;
    indexName?: string;
    indexType?: string;
    condition?: string;
    partsSelected?: number;
    partsTotal?: number;
    granulesSelected?: number;
    granulesTotal?: number;
}

export interface PlanSummary {
    /** Tables the plan reads, in the order they appear. */
    tables: string[];
    indexes: IndexUsage[];
    /** True when at least one index dropped parts or granules. */
    prunes: boolean;
}

/**
 * Characters ClickHouse uses to draw the plan's shape.
 *
 * Recent versions prefix operators with box-drawing runs like `\u2502  ` and
 * `\u2514\u2500\u2500`, while the properties beneath them are indented with plain
 * spaces. Counting only spaces would flatten the whole operator level, so the
 * prefix is measured as a whole.
 */
const PREFIX_CHARACTERS = new Set([' ', '\t', '\u2502', '\u251c', '\u2514', '\u2500']);

export function prefixWidth(line: string): number {
    let width = 0;
    while (width < line.length && PREFIX_CHARACTERS.has(line[width])) width++;
    return width;
}

/** Build a tree from the drawn shape of each line. */
export function parsePlan(text: string): PlanNode[] {
    const roots: PlanNode[] = [];
    const stack: PlanNode[] = [];

    for (const raw of text.split('\n')) {
        if (!raw.trim()) continue;
        const depth = prefixWidth(raw);
        const node: PlanNode = { text: raw.slice(depth).trim(), depth, children: [] };

        while (stack.length > 0 && stack[stack.length - 1].depth >= depth) stack.pop();
        if (stack.length === 0) roots.push(node);
        else stack[stack.length - 1].children.push(node);
        stack.push(node);
    }

    return roots;
}

const FRACTION = /^(\d+)\s*\/\s*(\d+)$/;

function fraction(value: string): { selected: number; total: number } | undefined {
    const match = FRACTION.exec(value.trim());
    if (!match) return undefined;
    return { selected: Number(match[1]), total: Number(match[2]) };
}

/**
 * Pull the numbers worth knowing out of a plan.
 *
 * `ReadFromMergeTree (db.table)` names the table; the `Indexes:` block beneath
 * it reports how much each index removed.
 */
export function summarizePlan(nodes: PlanNode[]): PlanSummary {
    const tables: string[] = [];
    const indexes: IndexUsage[] = [];

    const visit = (node: PlanNode, currentTable: string | undefined): void => {
        let table = currentTable;

        const read = /^ReadFrom\w*\s*\(([^)]+)\)/.exec(node.text);
        if (read) {
            table = read[1].trim();
            if (!tables.includes(table)) tables.push(table);
        }

        if (/^Indexes:$/i.test(node.text)) {
            for (const indexNode of node.children) {
                // `Ranges: 1` and friends sit alongside the indexes but are
                // properties of the block, not indexes: a real index has details.
                if (indexNode.children.length === 0) continue;
                indexes.push(readIndex(indexNode, table));
            }
            return;
        }

        for (const child of node.children) visit(child, table);
    };

    for (const node of nodes) visit(node, undefined);

    const prunes = indexes.some(
        index =>
            (index.partsTotal !== undefined && index.partsSelected !== undefined && index.partsSelected < index.partsTotal) ||
            (index.granulesTotal !== undefined &&
                index.granulesSelected !== undefined &&
                index.granulesSelected < index.granulesTotal)
    );

    return { tables, indexes, prunes };
}

function readIndex(node: PlanNode, table: string | undefined): IndexUsage {
    const usage: IndexUsage = { table };
    // The node itself is the index name, e.g. `PrimaryKey` or `MinMax`.
    usage.indexName = node.text.trim();

    for (const child of node.children) {
        const [label, ...rest] = child.text.split(':');
        const value = rest.join(':').trim();
        switch (label.trim().toLowerCase()) {
            case 'type':
                usage.indexType = value;
                break;
            case 'condition':
                usage.condition = value;
                break;
            case 'parts': {
                const parsed = fraction(value);
                if (parsed) {
                    usage.partsSelected = parsed.selected;
                    usage.partsTotal = parsed.total;
                }
                break;
            }
            case 'granules': {
                const parsed = fraction(value);
                if (parsed) {
                    usage.granulesSelected = parsed.selected;
                    usage.granulesTotal = parsed.total;
                }
                break;
            }
        }
    }
    return usage;
}

function percent(selected: number, total: number): string {
    if (total === 0) return '0%';
    return `${((selected / total) * 100).toFixed(1)}%`;
}

/** One line per index, saying how much it actually removed. */
export function describeIndex(usage: IndexUsage): string {
    const parts: string[] = [usage.indexName ?? 'index'];
    if (usage.indexType) parts.push(`(${usage.indexType})`);
    if (usage.partsSelected !== undefined && usage.partsTotal !== undefined) {
        parts.push(`parts ${usage.partsSelected}/${usage.partsTotal} (${percent(usage.partsSelected, usage.partsTotal)})`);
    }
    if (usage.granulesSelected !== undefined && usage.granulesTotal !== undefined) {
        parts.push(
            `granules ${usage.granulesSelected}/${usage.granulesTotal} (${percent(usage.granulesSelected, usage.granulesTotal)})`
        );
    }
    return parts.join('  ');
}

/** Render the tree with box-drawing characters. */
export function renderTree(nodes: PlanNode[], prefix = ''): string[] {
    const lines: string[] = [];
    nodes.forEach((node, index) => {
        const last = index === nodes.length - 1;
        lines.push(`${prefix}${last ? String.fromCharCode(0x2514) : String.fromCharCode(0x251c)}${String.fromCharCode(0x2500)} ${node.text}`);
        const childPrefix = `${prefix}${last ? '   ' : String.fromCharCode(0x2502) + '  '}`;
        lines.push(...renderTree(node.children, childPrefix));
    });
    return lines;
}

export interface ExplainDocumentInput {
    kind: string;
    sql: string;
    profile: string;
    raw: string;
}

/** The whole read-only document: summary first, then the plan. */
export function buildExplainDocument(input: ExplainDocumentInput): string {
    const nodes = parsePlan(input.raw);
    const summary = summarizePlan(nodes);

    const lines: string[] = [];
    lines.push(`-- EXPLAIN ${input.kind} on ${input.profile}`);
    lines.push(`-- ${input.sql.replace(/\s+/g, ' ').slice(0, 160)}`);
    lines.push('');

    if (summary.tables.length > 0) {
        lines.push(`Tables read: ${summary.tables.join(', ')}`);
    }

    if (summary.indexes.length > 0) {
        lines.push('');
        lines.push('Index usage');
        for (const index of summary.indexes) {
            lines.push(`  ${index.table ? `${index.table}  ` : ''}${describeIndex(index)}`);
            if (index.condition) lines.push(`      condition: ${index.condition}`);
        }
        if (!summary.prunes) {
            lines.push('');
            lines.push('  No index removed any parts or granules - this reads everything.');
        }
    } else if (summary.tables.length > 0) {
        lines.push('');
        lines.push('No index information. Run EXPLAIN with indexes = 1 to see pruning.');
    }

    lines.push('');
    lines.push('Plan');
    lines.push(...(nodes.length > 0 ? renderTree(nodes) : ['  (empty)']));
    return lines.join('\n');
}
