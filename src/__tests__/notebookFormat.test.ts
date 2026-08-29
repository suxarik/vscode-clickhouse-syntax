/**
 * Tests for the notebook file format.
 *
 * These are people's files. The property that matters most is that opening a
 * script as a notebook and saving it without editing leaves it byte for byte as
 * it was - so most of these tests are round-trips.
 */
import { parseCells, writeCells, markerFor, isMarker, TextCell } from '../notebook/format';

/** Parse and write back, which should be the identity for a canonical file. */
const roundTrip = (text: string) => writeCells(parseCells(text));

describe('reading cells', () => {
    it('treats a plain script as one code cell', () => {
        const cells = parseCells('SELECT 1\n');
        expect(cells).toHaveLength(1);
        expect(cells[0]).toMatchObject({ kind: 'code', value: 'SELECT 1' });
        expect(cells[0].marker).toBeUndefined();
    });

    it('splits on the marker', () => {
        const cells = parseCells('-- %%\nSELECT 1\n\n-- %%\nSELECT 2\n');
        expect(cells.map(cell => cell.value)).toEqual(['SELECT 1', 'SELECT 2']);
        expect(cells.every(cell => cell.kind === 'code')).toBe(true);
    });

    it('keeps a leading block that comes before the first marker', () => {
        const cells = parseCells('SELECT 0\n\n-- %%\nSELECT 1\n');
        expect(cells.map(cell => cell.value)).toEqual(['SELECT 0', 'SELECT 1']);
        expect(cells[0].marker).toBeUndefined();
    });

    it('reads a markdown cell with the comment prefix stripped', () => {
        const cells = parseCells('-- %% markdown\n-- # Heading\n--\n-- Prose.\n');
        expect(cells[0]).toMatchObject({ kind: 'markup', value: '# Heading\n\nProse.' });
    });

    it('accepts the ways people write the markdown marker', () => {
        for (const marker of ['-- %% markdown', '-- %% md', '-- %% [markdown]', '-- %%[md]', '--%% MARKDOWN']) {
            expect(parseCells(`${marker}\n-- hi\n`)[0].kind).toBe('markup');
        }
    });

    it('treats anything else after the marker as a title on a code cell', () => {
        const cells = parseCells('-- %% count the events\nSELECT count() FROM events\n');
        expect(cells[0].kind).toBe('code');
        expect(cells[0].marker).toBe('-- %% count the events');
    });

    it('tolerates whitespace around the marker', () => {
        expect(isMarker('  --   %%  ')).toBe(true);
        expect(isMarker('\t--%%')).toBe(true);
        // Not a marker: a comment that merely mentions percent signs.
        expect(isMarker('-- 50%% done')).toBe(false);
        expect(isMarker('SELECT 1 -- %%')).toBe(false);
    });

    it('gives an empty file one empty cell to type into', () => {
        const cells = parseCells('');
        expect(cells).toHaveLength(1);
        expect(cells[0]).toMatchObject({ kind: 'code', value: '' });
        // And writing it back still produces an empty file, not a blank line.
        expect(writeCells(cells)).toBe('');
    });

    it('does not invent a leading cell for a file that opens with a marker', () => {
        expect(parseCells('-- %%\nSELECT 1\n')).toHaveLength(1);
        expect(parseCells('\n\n-- %%\nSELECT 1\n')).toHaveLength(1);
    });

    it('keeps a line inside a markdown cell that is not a comment at all', () => {
        // Losing content is worse than an odd-looking cell.
        expect(parseCells('-- %% md\n-- prose\nSELECT 1\n')[0].value).toBe('prose\nSELECT 1');
    });
});

describe('round-tripping', () => {
    const files = [
        'SELECT 1\n',
        'SELECT 1',
        '-- %%\nSELECT 1\n',
        '-- %%\nSELECT 1;\n\n-- %%\nSELECT 2\n',
        '-- %% markdown\n-- # Why is this slow\n--\n-- Start here.\n\n-- %%\nSELECT count() FROM system.parts\n',
        'SELECT 0;\n\n-- %% md\n-- prose\n\n-- %%\nSELECT 1\n',
        '-- %% count the events\nSELECT count()\n',
        '',
        '\n',
        '-- %%\n\n-- %%\nSELECT 2\n',
    ];

    it.each(files)('leaves %j exactly as it was', file => {
        expect(roundTrip(file)).toBe(file);
    });

    it('preserves the blank lines between cells', () => {
        const file = '-- %%\nSELECT 1;\n\n\n\n-- %%\nSELECT 2\n';
        expect(roundTrip(file)).toBe(file);
    });

    it('preserves a file with no trailing newline', () => {
        const file = '-- %%\nSELECT 1;\n\n-- %%\nSELECT 2';
        expect(roundTrip(file)).toBe(file);
    });

    it('preserves an unusual but valid marker verbatim', () => {
        const file = '--%%[md]\n-- hi\n';
        expect(roundTrip(file)).toBe(file);
    });

    it('stays valid SQL: every line is either a statement or a comment', () => {
        const file = writeCells([
            { kind: 'markup', value: '# Heading\n\nProse with a -- dash.', trailingBlankLines: 1 },
            { kind: 'code', value: 'SELECT 1', trailingBlankLines: 1 },
        ]);
        for (const line of file.split('\n')) {
            const isComment = line.trimStart().startsWith('--');
            const isSql = line.trim() === '' || line.startsWith('SELECT');
            expect({ line, ok: isComment || isSql }).toMatchObject({ ok: true });
        }
    });
});

describe('writing cells', () => {
    it('gives a new cell a marker, so cells do not merge on the next read', () => {
        const cells: TextCell[] = [
            { kind: 'code', value: 'SELECT 1', trailingBlankLines: 1 },
            { kind: 'code', value: 'SELECT 2', trailingBlankLines: 0 },
        ];
        const text = writeCells(cells);
        expect(text).toBe('SELECT 1;\n\n-- %%\nSELECT 2');
        expect(parseCells(text).map(cell => cell.value)).toEqual(['SELECT 1;', 'SELECT 2']);
    });

    it('comments every line of a markdown cell', () => {
        const text = writeCells([{ kind: 'markup', value: 'one\n\ntwo', trailingBlankLines: 0 }]);
        expect(text).toBe('-- %% markdown\n-- one\n--\n-- two');
    });

    it('never writes an output, because there is nowhere to put one', () => {
        // The format has no output section at all, which is what makes
        // "outputs are never written to disk" a property rather than a promise.
        const text = writeCells(parseCells('-- %%\nSELECT 1\n'));
        expect(text).not.toMatch(/output|result|rows/i);
    });
});

describe('a cell that changed kind', () => {
    it('loses a marker that now says the wrong thing', () => {
        expect(markerFor({ kind: 'code', value: 'SELECT 1', marker: '-- %% markdown', trailingBlankLines: 0 })).toBe(
            '-- %%'
        );
        expect(markerFor({ kind: 'markup', value: 'hi', marker: '-- %%', trailingBlankLines: 0 })).toBe(
            '-- %% markdown'
        );
    });

    it('keeps a marker that still fits, title and all', () => {
        expect(
            markerFor({ kind: 'code', value: 'SELECT 1', marker: '-- %% count', trailingBlankLines: 0 })
        ).toBe('-- %% count');
    });

    it('leaves a leading cell without one', () => {
        expect(markerFor({ kind: 'code', value: 'SELECT 1', trailingBlankLines: 0 })).toBeUndefined();
    });
});


describe('statement terminators', () => {
    /**
     * Without these the file is not the script it claims to be. Verified
     * against a real server: `clickhouse-client --multiquery` reads `LIMIT 10`,
     * a comment and the next `SELECT` as one malformed statement and reports a
     * syntax error at the second cell.
     */
    it('ends a cell that is followed by more SQL', () => {
        expect(writeCells(parseCells('-- %%\nSELECT 1\n\n-- %%\nSELECT 2\n'))).toBe(
            '-- %%\nSELECT 1;\n\n-- %%\nSELECT 2\n'
        );
    });

    it('leaves the last statement alone, so a plain script is untouched', () => {
        expect(writeCells(parseCells('SELECT 1\n'))).toBe('SELECT 1\n');
        expect(writeCells(parseCells('-- %%\nSELECT 1\n'))).toBe('-- %%\nSELECT 1\n');
    });

    it('does not double one that is already there', () => {
        expect(writeCells(parseCells('-- %%\nSELECT 1;\n\n-- %%\nSELECT 2\n'))).toBe(
            '-- %%\nSELECT 1;\n\n-- %%\nSELECT 2\n'
        );
    });

    it('ignores markdown cells when deciding which SQL cell is last', () => {
        // The prose after the final query is not a reason to terminate it.
        const file = '-- %%\nSELECT 1\n\n-- %% md\n-- afterword\n';
        expect(writeCells(parseCells(file))).toBe(file);
    });

    it('puts it after the content, not after the blank lines', () => {
        const cells: TextCell[] = [
            { kind: 'code', value: 'SELECT 1\n', trailingBlankLines: 1 },
            { kind: 'code', value: 'SELECT 2', trailingBlankLines: 0 },
        ];
        // The value's own trailing newline and the blank line after it both
        // survive; only the semicolon moves in, right after the content.
        expect(writeCells(cells)).toBe('SELECT 1;\n\n\n-- %%\nSELECT 2');
    });

    it('leaves an empty cell empty rather than writing a bare semicolon', () => {
        expect(writeCells(parseCells('-- %%\n\n-- %%\nSELECT 2\n'))).toBe('-- %%\n\n-- %%\nSELECT 2\n');
    });
});
