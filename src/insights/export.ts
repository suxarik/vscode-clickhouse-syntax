/**
 * Insights as a file: what the page is showing, in the order it is showing it.
 */
import { QueryShape } from './types';

export type ExportFormat = 'csv' | 'json';

export const EXPORT_FORMATS: readonly ExportFormat[] = ['csv', 'json'];

const COLUMNS: Array<[string, (shape: QueryShape, rank: number) => string | number]> = [
    ['rank', (_, rank) => rank],
    ['example', shape => shape.example],
    ['user', shape => shape.user],
    ['tables', shape => shape.tables.join('; ')],
    ['runs', shape => shape.runs],
    ['total_ms', shape => Math.round(shape.totalMs)],
    ['p95_ms', shape => Math.round(shape.p95Ms)],
    ['max_ms', shape => Math.round(shape.maxMs)],
    ['avg_read_rows', shape => Math.round(shape.avgReadRows)],
    ['avg_read_bytes', shape => Math.round(shape.avgReadBytes)],
    ['avg_result_rows', shape => Math.round(shape.avgResultRows)],
    ['peak_memory_bytes', shape => shape.peakMemory],
    ['errors', shape => shape.errors],
    ['last_error_code', shape => shape.lastErrorCode],
    ['last_error', shape => shape.lastError],
    ['query_hash', shape => shape.hash],
];

function csvCell(value: string | number): string {
    const text = String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** `rows` pairs each shape with its position in the lens, which is its rank. */
export function exportShapes(rows: Array<{ shape: QueryShape; rank: number }>, format: ExportFormat): string {
    if (format === 'json') {
        return JSON.stringify(
            rows.map(({ shape, rank }) => ({
                rank,
                example: shape.example,
                user: shape.user,
                tables: shape.tables,
                runs: shape.runs,
                total_ms: Math.round(shape.totalMs),
                p95_ms: Math.round(shape.p95Ms),
                max_ms: Math.round(shape.maxMs),
                avg_read_rows: Math.round(shape.avgReadRows),
                avg_read_bytes: Math.round(shape.avgReadBytes),
                avg_result_rows: Math.round(shape.avgResultRows),
                peak_memory_bytes: shape.peakMemory,
                errors: shape.errors,
                last_error_code: shape.lastErrorCode,
                last_error: shape.lastError,
                query_hash: shape.hash,
            })),
            null,
            2
        );
    }
    const lines = [COLUMNS.map(([name]) => name).join(',')];
    for (const { shape, rank } of rows) {
        lines.push(COLUMNS.map(([, value]) => csvCell(value(shape, rank))).join(','));
    }
    return lines.join('\n');
}
