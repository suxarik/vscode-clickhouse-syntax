/**
 * Grid state: sorting, filtering and the visible window.
 *
 * Kept free of the DOM so the interesting behaviour can be tested directly, and
 * so the same logic serves the panel and, later, the notebook renderer.
 */
import { isNumericType, formatValue } from './format';
import { ColumnMeta } from './protocol';

export type SortDirection = 'asc' | 'desc';

export interface SortState {
    column: number;
    direction: SortDirection;
}

export interface WindowRange {
    /** First row index to render. */
    start: number;
    /** One past the last row index to render. */
    end: number;
    /** Pixels of spacer above the rendered rows. */
    offsetTop: number;
    /** Total scrollable height. */
    totalHeight: number;
}

/**
 * Which rows to render for a scroll position.
 *
 * An overscan margin either side keeps fast scrolling from showing gaps.
 */
export function visibleWindow(
    rowCount: number,
    rowHeight: number,
    scrollTop: number,
    viewportHeight: number,
    overscan = 10
): WindowRange {
    const safeHeight = Math.max(1, rowHeight);
    const first = Math.max(0, Math.floor(scrollTop / safeHeight) - overscan);
    const visible = Math.ceil(viewportHeight / safeHeight) + overscan * 2;
    const end = Math.min(rowCount, first + visible);
    return {
        start: Math.min(first, Math.max(0, end)),
        end,
        offsetTop: Math.min(first, Math.max(0, end)) * safeHeight,
        totalHeight: rowCount * safeHeight,
    };
}

/**
 * Compare two cells of one column.
 *
 * NULLs sort last in both directions — they are absence, not a value, and
 * burying them under a descending sort is never what someone wants.
 */
export function compareValues(a: unknown, b: unknown, type: string): number {
    const aNull = a === null || a === undefined;
    const bNull = b === null || b === undefined;
    if (aNull && bNull) return 0;
    if (aNull) return 1;
    if (bNull) return -1;

    if (isNumericType(type)) {
        // 64-bit integers arrive as strings; compare them as BigInt so values
        // past 2^53 order correctly.
        const left = toComparableNumber(a);
        const right = toComparableNumber(b);
        if (typeof left === 'bigint' && typeof right === 'bigint') {
            return left < right ? -1 : left > right ? 1 : 0;
        }
        return Number(left) - Number(right);
    }

    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

function toComparableNumber(value: unknown): number | bigint {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number') return value;
    const text = String(value);
    if (/^-?\d+$/.test(text)) {
        try {
            return BigInt(text);
        } catch {
            return Number(text);
        }
    }
    return Number(text);
}

/**
 * Row indices in display order.
 *
 * Returns indices rather than reordered rows so the underlying array is never
 * copied — it can hold a hundred thousand rows.
 */
export function sortedIndices(rows: unknown[][], columns: ColumnMeta[], sort: SortState | undefined): number[] {
    const indices = rows.map((_, index) => index);
    if (!sort) return indices;

    const type = columns[sort.column]?.type ?? '';
    const sign = sort.direction === 'asc' ? 1 : -1;
    return indices.sort((a, b) => {
        const nulls = compareValues(rows[a][sort.column], rows[b][sort.column], type);
        // Keep NULLs last regardless of direction.
        const aNull = rows[a][sort.column] === null;
        const bNull = rows[b][sort.column] === null;
        if (aNull !== bNull) return aNull ? 1 : -1;
        return nulls * sign;
    });
}

/** Indices of rows containing `needle` in any column, case-insensitively. */
export function filteredIndices(
    rows: unknown[][],
    columns: ColumnMeta[],
    needle: string,
    from?: number[]
): number[] {
    const query = needle.trim().toLowerCase();
    const source = from ?? rows.map((_, index) => index);
    if (!query) return source;

    return source.filter(index =>
        rows[index].some((value, column) =>
            formatValue(value, columns[column]?.type ?? '')
                .toLowerCase()
                .includes(query)
        )
    );
}

/** Cycle a column header: unsorted → ascending → descending → unsorted. */
export function nextSort(current: SortState | undefined, column: number): SortState | undefined {
    if (!current || current.column !== column) return { column, direction: 'asc' };
    if (current.direction === 'asc') return { column, direction: 'desc' };
    return undefined;
}
