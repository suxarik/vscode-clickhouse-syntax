/**
 * Rendering ClickHouse values for display.
 *
 * Values arrive as JSON, with one deliberate wrinkle: 64-bit integers and
 * decimals come through as strings so `JSON.parse` cannot round them. That means
 * "is this a number" is a question about the column type, not the JavaScript
 * type.
 */

/** Column types whose values are numeric even when they arrive as strings. */
const NUMERIC_TYPE = /^(U?Int\d+|Float\d+|Decimal|BFloat16)/;
const DATE_TYPE = /^(Date|DateTime)/;

export function isNumericType(type: string): boolean {
    return NUMERIC_TYPE.test(stripWrappers(type));
}

export function isDateType(type: string): boolean {
    return DATE_TYPE.test(stripWrappers(type));
}

/** Peel `Nullable(...)` and `LowCardinality(...)` to reach the real type. */
export function stripWrappers(type: string): string {
    let current = type.trim();
    for (;;) {
        const match = /^(?:Nullable|LowCardinality)\((.*)\)$/s.exec(current);
        if (!match) return current;
        current = match[1].trim();
    }
}

/** True for values that need an expander rather than a single line. */
export function isComposite(value: unknown): boolean {
    return value !== null && typeof value === 'object';
}

export interface FormatOptions {
    /** Truncate the rendered text at this length. 0 keeps it whole. */
    maxLength?: number;
}

/**
 * A single-line rendering of a cell.
 *
 * Arrays render as `[…]`, maps and JSON objects as `{…}`, tuples as `(…)` — but
 * ClickHouse sends a tuple as a JSON array, so tuples are told apart by the
 * column type rather than the value.
 */
export function formatValue(value: unknown, type = '', options: FormatOptions = {}): string {
    const text = render(value, stripWrappers(type));
    const max = options.maxLength ?? 0;
    if (max > 0 && text.length > max) return `${text.slice(0, max - 1)}…`;
    return text;
}

function render(value: unknown, type: string): string {
    if (value === null || value === undefined) return 'NULL';

    if (Array.isArray(value)) {
        const inner = innerTypesOf(type);
        const parts = value.map((item, index) => render(item, inner[index] ?? inner[0] ?? ''));
        return type.startsWith('Tuple') ? `(${parts.join(', ')})` : `[${parts.join(', ')}]`;
    }

    if (typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>);
        return `{${entries.map(([key, item]) => `${key}: ${render(item, '')}`).join(', ')}}`;
    }

    if (typeof value === 'string') return value;
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    return String(value);
}

/** Element types of a composite type: `Tuple(UInt8, String)` → the two parts. */
export function innerTypesOf(type: string): string[] {
    const match = /^(?:Array|Tuple|Map|Nested)\((.*)\)$/s.exec(stripWrappers(type));
    if (!match) return [];
    return splitTopLevel(match[1]);
}

/** Split on commas that are not inside brackets or quotes. */
export function splitTopLevel(text: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let quote: string | null = null;
    let current = '';

    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (quote) {
            current += char;
            if (char === quote && text[i - 1] !== '\\') quote = null;
            continue;
        }
        if (char === "'" || char === '"') {
            quote = char;
            current += char;
            continue;
        }
        if (char === '(' || char === '[') depth++;
        else if (char === ')' || char === ']') depth--;
        else if (char === ',' && depth === 0) {
            parts.push(current.trim());
            current = '';
            continue;
        }
        current += char;
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
}

/**
 * Multi-line rendering for the expanded cell view.
 *
 * The column type is accepted for symmetry with `formatValue` and so callers do
 * not have to special-case it; the expanded form is driven by the value alone.
 */
export function formatExpanded(value: unknown, _type = ''): string {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value !== 'object') return String(value);
    return JSON.stringify(value, null, 2);
}

/** `1234567` → `1.23 M`, for the footer. */
export function formatCount(value: number | undefined): string {
    if (value === undefined || !Number.isFinite(value)) return '—';
    if (value < 1000) return String(value);
    const units = ['K', 'M', 'B', 'T'];
    let scaled = value;
    let unit = -1;
    while (scaled >= 1000 && unit < units.length - 1) {
        scaled /= 1000;
        unit++;
    }
    return `${scaled.toFixed(scaled < 10 ? 2 : 1)} ${units[unit]}`;
}

/** `1048576` → `1.00 MiB`. */
export function formatBytes(value: number | undefined): string {
    if (value === undefined || !Number.isFinite(value)) return '—';
    if (value < 1024) return `${value} B`;
    const units = ['KiB', 'MiB', 'GiB', 'TiB'];
    let scaled = value;
    let unit = -1;
    while (scaled >= 1024 && unit < units.length - 1) {
        scaled /= 1024;
        unit++;
    }
    return `${scaled.toFixed(2)} ${units[unit]}`;
}

/** `1234` → `1.23 s`. */
export function formatDuration(ms: number | undefined): string {
    if (ms === undefined || !Number.isFinite(ms)) return '—';
    if (ms < 1000) return `${Math.round(ms)} ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
    const minutes = Math.floor(ms / 60_000);
    return `${minutes}m ${Math.round((ms % 60_000) / 1000)}s`;
}
