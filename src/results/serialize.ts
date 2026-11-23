/**
 * Turning a result into text for the clipboard or a file.
 */
import { formatValue } from './format';
import { ColumnMeta, SerializationFormat } from './protocol';

export interface SerializeInput {
    columns: ColumnMeta[];
    rows: unknown[][];
    /** Include a header row where the format has one. */
    includeHeader?: boolean;
}

/** A cell as text, with composites rendered as compact JSON. */
function cellText(value: unknown, type: string): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return formatValue(value, type);
}

function toTsv(input: SerializeInput): string {
    const lines: string[] = [];
    if (input.includeHeader !== false) lines.push(input.columns.map(column => column.name).join('\t'));
    for (const row of input.rows) {
        lines.push(
            row
                .map((value, index) =>
                    // Tabs and newlines would break the row, so escape them the
                    // way ClickHouse's own TabSeparated format does.
                    cellText(value, input.columns[index]?.type ?? '')
                        .replace(/\\/g, '\\\\')
                        .replace(/\t/g, '\\t')
                        .replace(/\n/g, '\\n')
                        .replace(/\r/g, '\\r')
                )
                .join('\t')
        );
    }
    return lines.join('\n');
}

function csvCell(text: string): string {
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(input: SerializeInput): string {
    const lines: string[] = [];
    if (input.includeHeader !== false) lines.push(input.columns.map(column => csvCell(column.name)).join(','));
    for (const row of input.rows) {
        lines.push(row.map((value, index) => csvCell(cellText(value, input.columns[index]?.type ?? ''))).join(','));
    }
    return lines.join('\n');
}

function toJson(input: SerializeInput): string {
    const objects = input.rows.map(row => {
        const object: Record<string, unknown> = {};
        input.columns.forEach((column, index) => {
            object[column.name] = row[index] ?? null;
        });
        return object;
    });
    return JSON.stringify(objects, null, 2);
}

/** One JSON object per line: ClickHouse's own `JSONEachRow`, which `INSERT … FORMAT JSONEachRow` reads back. */
function toJsonLines(input: SerializeInput): string {
    return input.rows
        .map(row => {
            const object: Record<string, unknown> = {};
            input.columns.forEach((column, index) => {
                object[column.name] = row[index] ?? null;
            });
            return JSON.stringify(object);
        })
        .join('\n');
}

const NUMERIC_TYPE = /^(U?Int(8|16|32|64|128|256)|Float(32|64)|BFloat16|Decimal(32|64|128|256)?(\(.*\))?)$/;
const NUMBER_TEXT = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$|^[-+]?(nan|inf)$/i;

/** `Nullable(LowCardinality(UInt8))` → `UInt8`, the type that decides how a value is written. */
function innerType(type: string): string {
    let current = type.trim();
    for (;;) {
        const wrapped = /^(?:Nullable|LowCardinality)\((.*)\)$/.exec(current);
        if (!wrapped) return current;
        current = wrapped[1];
    }
}

function quote(text: string): string {
    return `'${text
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t')
        .replace(/\0/g, '\\0')}'`;
}

function numberLiteral(value: number): string {
    if (Number.isNaN(value)) return 'nan';
    if (!Number.isFinite(value)) return value > 0 ? 'inf' : '-inf';
    return String(value);
}

/**
 * A value as a ClickHouse literal.
 *
 * Numbers are written bare when the column says they are numbers, even though a
 * 64-bit one arrives as a string to stay exact. Everything else is quoted and
 * escaped, so a value cannot close the string it sits in.
 */
function literal(value: unknown, type: string): string {
    if (value === null || value === undefined) return 'NULL';
    const inner = innerType(type);

    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number') return numberLiteral(value);
    if (typeof value === 'string') {
        return NUMERIC_TYPE.test(inner) && NUMBER_TEXT.test(value.trim()) ? value.trim() : quote(value);
    }
    if (Array.isArray(value)) {
        const element = /^Array\((.*)\)$/.exec(inner)?.[1] ?? '';
        const items = value.map(item => literal(item, element));
        return inner.startsWith('Tuple(') ? `(${items.join(', ')})` : `[${items.join(', ')}]`;
    }
    if (typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>).map(
            ([key, item]) => `${quote(key)}: ${literal(item, '')}`
        );
        return `{${entries.join(', ')}}`;
    }
    return quote(String(value));
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const identifier = (name: string): string => (IDENTIFIER.test(name) ? name : `\`${name.replace(/`/g, '\\`')}\``);

/** A statement that puts these rows back. The table is a placeholder to be edited, since a result has no table. */
function toInsert(input: SerializeInput): string {
    if (input.rows.length === 0) return '';
    const columns = input.columns.map(column => identifier(column.name)).join(', ');
    const values = input.rows.map(
        row => `(${input.columns.map((column, index) => literal(row[index], column.type)).join(', ')})`
    );
    return `INSERT INTO table_name (${columns}) VALUES\n${values.join(',\n')};`;
}

function toMarkdown(input: SerializeInput): string {
    const header = input.columns.map(column => column.name);
    const escape = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
    const body = input.rows.map(row =>
        row.map((value, index) => escape(cellText(value, input.columns[index]?.type ?? '')))
    );

    // Pad so the source table is readable, not just the rendered one.
    const widths = header.map((name, index) =>
        Math.max(name.length, 3, ...body.map(row => (row[index] ?? '').length))
    );
    const line = (cells: string[]) =>
        `| ${cells.map((cell, index) => cell.padEnd(widths[index])).join(' | ')} |`;

    return [
        line(header),
        `| ${widths.map(width => '-'.repeat(width)).join(' | ')} |`,
        ...body.map(line),
    ].join('\n');
}

export function serialize(input: SerializeInput, format: SerializationFormat): string {
    switch (format) {
        case 'csv':
            return toCsv(input);
        case 'json':
            return toJson(input);
        case 'jsonl':
            return toJsonLines(input);
        case 'sql':
            return toInsert(input);
        case 'markdown':
            return toMarkdown(input);
        default:
            return toTsv(input);
    }
}

export const FILE_EXTENSION: Record<SerializationFormat, string> = {
    tsv: 'tsv',
    csv: 'csv',
    json: 'json',
    jsonl: 'jsonl',
    sql: 'sql',
    markdown: 'md',
};
