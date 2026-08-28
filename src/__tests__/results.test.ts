/**
 * Tests for value formatting, serialization and grid state.
 */
import {
    formatBytes,
    formatCount,
    formatDuration,
    formatExpanded,
    formatValue,
    innerTypesOf,
    isDateType,
    isNumericType,
    splitTopLevel,
    stripWrappers,
} from '../results/format';
import { FILE_EXTENSION, serialize } from '../results/serialize';
import {
    compareValues,
    filteredIndices,
    nextSort,
    sortedIndices,
    visibleWindow,
} from '../results/grid';
import { ColumnMeta } from '../results/protocol';

describe('type inspection', () => {
    it('peels Nullable and LowCardinality', () => {
        expect(stripWrappers('Nullable(String)')).toBe('String');
        expect(stripWrappers('LowCardinality(Nullable(String))')).toBe('String');
        expect(stripWrappers('UInt64')).toBe('UInt64');
    });

    it('recognises numeric types through wrappers', () => {
        expect(isNumericType('UInt64')).toBe(true);
        expect(isNumericType('Nullable(Int32)')).toBe(true);
        expect(isNumericType('Decimal(18, 2)')).toBe(true);
        expect(isNumericType('Float64')).toBe(true);
        expect(isNumericType('String')).toBe(false);
        expect(isNumericType('Array(UInt8)')).toBe(false);
    });

    it('recognises date types', () => {
        expect(isDateType('DateTime64(3)')).toBe(true);
        expect(isDateType('Nullable(Date)')).toBe(true);
        expect(isDateType('UInt64')).toBe(false);
    });

    it('splits composite type arguments', () => {
        expect(innerTypesOf('Tuple(UInt8, String)')).toEqual(['UInt8', 'String']);
        expect(innerTypesOf('Map(String, Array(UInt8))')).toEqual(['String', 'Array(UInt8)']);
        expect(innerTypesOf('UInt64')).toEqual([]);
    });

    it('does not split inside brackets or quotes', () => {
        expect(splitTopLevel("Enum8('a' = 1, 'b' = 2), UInt8")).toEqual(["Enum8('a' = 1, 'b' = 2)", 'UInt8']);
    });
});

describe('formatValue', () => {
    it('renders NULL', () => {
        expect(formatValue(null, 'Nullable(String)')).toBe('NULL');
    });

    it('renders scalars as themselves', () => {
        expect(formatValue(42, 'UInt8')).toBe('42');
        expect(formatValue('text', 'String')).toBe('text');
        // A big UInt64 arrives as a string and must stay exact.
        expect(formatValue('18446744073709551615', 'UInt64')).toBe('18446744073709551615');
    });

    it('renders arrays with brackets', () => {
        expect(formatValue([1, 2, 3], 'Array(UInt8)')).toBe('[1, 2, 3]');
    });

    it('renders tuples with parentheses, told apart by the type', () => {
        expect(formatValue([1, 'x'], 'Tuple(UInt8, String)')).toBe("(1, x)");
        expect(formatValue([1, 2], 'Array(UInt8)')).toBe('[1, 2]');
    });

    it('renders maps and JSON with braces', () => {
        expect(formatValue({ a: 1 }, 'Map(String, UInt8)')).toBe('{a: 1}');
    });

    it('renders nested composites', () => {
        expect(formatValue([[1, 2], [3]], 'Array(Array(UInt8))')).toBe('[[1, 2], [3]]');
    });

    it('renders NULL inside a composite', () => {
        expect(formatValue([1, null], 'Array(Nullable(UInt8))')).toBe('[1, NULL]');
    });

    it('truncates when asked', () => {
        expect(formatValue('abcdefghij', 'String', { maxLength: 5 })).toBe('abcd…');
        expect(formatValue('abc', 'String', { maxLength: 5 })).toBe('abc');
    });

    it('expands composites over several lines', () => {
        expect(formatExpanded({ a: 1 }, 'Map(String, UInt8)')).toBe('{\n  "a": 1\n}');
        expect(formatExpanded('plain', 'String')).toBe('plain');
    });
});

describe('footer formatting', () => {
    it('scales counts', () => {
        expect(formatCount(42)).toBe('42');
        expect(formatCount(1234)).toBe('1.23 K');
        expect(formatCount(12_345_678)).toBe('12.3 M');
        expect(formatCount(undefined)).toBe('—');
    });

    it('scales bytes', () => {
        expect(formatBytes(512)).toBe('512 B');
        expect(formatBytes(1024)).toBe('1.00 KiB');
        expect(formatBytes(1_048_576)).toBe('1.00 MiB');
    });

    it('scales durations', () => {
        expect(formatDuration(42)).toBe('42 ms');
        expect(formatDuration(1500)).toBe('1.50 s');
        expect(formatDuration(90_000)).toBe('1m 30s');
    });
});

describe('serialize', () => {
    const columns: ColumnMeta[] = [
        { name: 'id', type: 'UInt64' },
        { name: 'name', type: 'String' },
    ];
    const rows: unknown[][] = [
        ['1', 'alpha'],
        ['2', null],
    ];

    it('writes TSV with a header', () => {
        expect(serialize({ columns, rows }, 'tsv')).toBe('id\tname\n1\talpha\n2\t');
    });

    it('escapes tabs and newlines in TSV', () => {
        expect(serialize({ columns, rows: [['1', 'a\tb\nc']] }, 'tsv')).toContain('a\\tb\\nc');
    });

    it('writes CSV, quoting where needed', () => {
        const output = serialize({ columns, rows: [['1', 'a,b'], ['2', 'say "hi"']] }, 'csv');
        expect(output).toContain('"a,b"');
        expect(output).toContain('"say ""hi"""');
    });

    it('writes JSON objects keyed by column', () => {
        expect(JSON.parse(serialize({ columns, rows }, 'json'))).toEqual([
            { id: '1', name: 'alpha' },
            { id: '2', name: null },
        ]);
    });

    it('writes an aligned markdown table', () => {
        const output = serialize({ columns, rows }, 'markdown').split('\n');
        expect(output[0]).toBe('| id  | name  |');
        expect(output[1]).toBe('| --- | ----- |');
        expect(output[2]).toBe('| 1   | alpha |');
    });

    it('escapes pipes in markdown', () => {
        expect(serialize({ columns, rows: [['1', 'a|b']] }, 'markdown')).toContain('a\\|b');
    });

    it('serialises composites as JSON', () => {
        const composite: ColumnMeta[] = [{ name: 'tags', type: 'Array(String)' }];
        expect(serialize({ columns: composite, rows: [[['a', 'b']]] }, 'csv')).toContain('"[""a"",""b""]"');
    });

    it('can omit the header', () => {
        expect(serialize({ columns, rows, includeHeader: false }, 'tsv')).toBe('1\talpha\n2\t');
    });

    it('maps formats to file extensions', () => {
        expect(FILE_EXTENSION.markdown).toBe('md');
        expect(FILE_EXTENSION.tsv).toBe('tsv');
    });
});

describe('visibleWindow', () => {
    it('renders only the rows around the viewport', () => {
        const window = visibleWindow(10_000, 22, 0, 440, 0);
        expect(window.start).toBe(0);
        expect(window.end).toBe(20);
        expect(window.totalHeight).toBe(220_000);
    });

    it('follows the scroll position', () => {
        const window = visibleWindow(10_000, 20, 4000, 400, 0);
        expect(window.start).toBe(200);
        expect(window.offsetTop).toBe(4000);
    });

    it('overscans either side', () => {
        expect(visibleWindow(10_000, 20, 4000, 400, 5).start).toBe(195);
    });

    it('does not run past the end', () => {
        const window = visibleWindow(10, 20, 0, 4000, 0);
        expect(window.end).toBe(10);
    });

    it('handles an empty result', () => {
        expect(visibleWindow(0, 20, 0, 400)).toMatchObject({ start: 0, end: 0, totalHeight: 0 });
    });
});

describe('compareValues', () => {
    it('orders numbers numerically, not as text', () => {
        expect(compareValues(9, 10, 'UInt8')).toBeLessThan(0);
        expect(compareValues('9', '10', 'UInt64')).toBeLessThan(0);
    });

    it('orders 64-bit integers past 2^53 correctly', () => {
        expect(compareValues('18446744073709551614', '18446744073709551615', 'UInt64')).toBeLessThan(0);
        expect(compareValues('18446744073709551615', '18446744073709551614', 'UInt64')).toBeGreaterThan(0);
    });

    it('orders strings lexicographically', () => {
        expect(compareValues('alpha', 'beta', 'String')).toBeLessThan(0);
    });

    it('puts NULL last', () => {
        expect(compareValues(null, 1, 'UInt8')).toBeGreaterThan(0);
        expect(compareValues(1, null, 'UInt8')).toBeLessThan(0);
        expect(compareValues(null, null, 'UInt8')).toBe(0);
    });
});

describe('sortedIndices', () => {
    const columns: ColumnMeta[] = [
        { name: 'n', type: 'UInt64' },
        { name: 's', type: 'String' },
    ];
    const rows: unknown[][] = [
        ['10', 'b'],
        ['9', 'a'],
        [null, 'c'],
    ];

    it('leaves the order alone when unsorted', () => {
        expect(sortedIndices(rows, columns, undefined)).toEqual([0, 1, 2]);
    });

    it('sorts ascending and descending', () => {
        expect(sortedIndices(rows, columns, { column: 0, direction: 'asc' })).toEqual([1, 0, 2]);
        expect(sortedIndices(rows, columns, { column: 0, direction: 'desc' })).toEqual([0, 1, 2]);
    });

    it('keeps NULL last in both directions', () => {
        expect(sortedIndices(rows, columns, { column: 0, direction: 'asc' }).at(-1)).toBe(2);
        expect(sortedIndices(rows, columns, { column: 0, direction: 'desc' }).at(-1)).toBe(2);
    });
});

describe('filteredIndices', () => {
    const columns: ColumnMeta[] = [
        { name: 'id', type: 'UInt64' },
        { name: 'name', type: 'String' },
    ];
    const rows: unknown[][] = [
        ['1', 'alpha'],
        ['2', 'beta'],
        ['3', null],
    ];

    it('matches any column, case-insensitively', () => {
        expect(filteredIndices(rows, columns, 'ALPHA')).toEqual([0]);
        expect(filteredIndices(rows, columns, '2')).toEqual([1]);
    });

    it('returns everything for an empty needle', () => {
        expect(filteredIndices(rows, columns, '   ')).toEqual([0, 1, 2]);
    });

    it('matches the rendered NULL', () => {
        expect(filteredIndices(rows, columns, 'null')).toEqual([2]);
    });

    it('narrows an existing selection', () => {
        expect(filteredIndices(rows, columns, 'a', [1, 2])).toEqual([1]);
    });
});

describe('nextSort', () => {
    it('cycles unsorted, ascending, descending, unsorted', () => {
        const first = nextSort(undefined, 1);
        expect(first).toEqual({ column: 1, direction: 'asc' });
        const second = nextSort(first, 1);
        expect(second).toEqual({ column: 1, direction: 'desc' });
        expect(nextSort(second, 1)).toBeUndefined();
    });

    it('starts fresh on a different column', () => {
        expect(nextSort({ column: 0, direction: 'desc' }, 1)).toEqual({ column: 1, direction: 'asc' });
    });
});
