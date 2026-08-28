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
    markdown: 'md',
};
