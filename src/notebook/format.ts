/**
 * The notebook file format: plain `.sql` with `-- %%` cell markers.
 *
 * There is no JSON container and no output section, and both are deliberate.
 * The file stays a ClickHouse script you can pipe straight to
 * `clickhouse-client`, diffs stay readable, and an existing `.sql` file becomes
 * a notebook with no conversion step. Outputs live for the session and are
 * never written down: a file that persists query results is a way for
 * production rows to end up in a commit.
 *
 * This module is deliberately free of `vscode`, so the format can be tested as
 * what it is - a pure text transformation.
 */

export type CellKind = 'code' | 'markup';

export interface TextCell {
    kind: CellKind;
    /** Cell content: SQL for a code cell, markdown with the `--` stripped. */
    value: string;
    /**
     * The exact marker line this cell came from, re-emitted verbatim.
     *
     * `undefined` means the cell had no marker - the leading block of a plain
     * `.sql` file. Writing it back does not invent one, so opening a script as
     * a notebook and saving it does not rewrite the first line.
     */
    marker?: string;
    /** Blank lines that followed the content, kept so a save is a no-op. */
    trailingBlankLines: number;
}

/** A cell boundary: a SQL comment, so the file still parses as SQL. */
const MARKER = /^[ \t]*--[ \t]*%%(.*)$/;

/** Markers whose suffix names a markup cell; anything else is a code cell. */
const MARKUP_SUFFIX = /^\[?\s*(markdown|md)\s*\]?$/i;

export function isMarker(line: string): boolean {
    return MARKER.test(line);
}

function kindOf(line: string): CellKind {
    const suffix = MARKER.exec(line)?.[1] ?? '';
    return MARKUP_SUFFIX.test(suffix.trim()) ? 'markup' : 'code';
}

/**
 * Strip the comment prefix from one line of a markup cell.
 *
 * A line that is not a comment at all is kept as it is, because losing content
 * is worse than an odd-looking cell.
 */
function uncomment(line: string): string {
    if (line.startsWith('-- ')) return line.slice(3);
    if (line === '--') return '';
    if (line.startsWith('--')) return line.slice(2);
    return line;
}

/** Comment one line of a markup cell, so the file remains valid SQL. */
function comment(line: string): string {
    return line.length === 0 ? '--' : `-- ${line}`;
}

/** Split a block of lines into its content and the blank lines after it. */
function splitTrailingBlanks(lines: string[]): { value: string[]; trailingBlankLines: number } {
    let end = lines.length;
    while (end > 0 && lines[end - 1].trim() === '') end--;
    return { value: lines.slice(0, end), trailingBlankLines: lines.length - end };
}

/**
 * Read a notebook out of the file text.
 *
 * Always returns at least one cell: an empty file is an empty notebook, not a
 * notebook with nothing to type into.
 */
export function parseCells(text: string): TextCell[] {
    const lines = text.split('\n');
    const cells: TextCell[] = [];

    let marker: string | undefined;
    let kind: CellKind = 'code';
    let block: string[] = [];

    /** `atMarker` is true when the block ended because a marker started. */
    const flush = (atMarker: boolean) => {
        // Blank lines before the first marker are spacing, not a cell. At the
        // end of the file they are the file, and dropping them would rewrite it.
        if (atMarker && marker === undefined && block.every(line => line.trim() === '')) return;
        const { value, trailingBlankLines } = splitTrailingBlanks(block);
        const body = kind === 'markup' ? value.map(uncomment) : value;
        const cell: TextCell = { kind, value: body.join('\n'), trailingBlankLines };
        if (marker !== undefined) cell.marker = marker;
        cells.push(cell);
    };

    for (const line of lines) {
        if (isMarker(line)) {
            flush(true);
            marker = line;
            kind = kindOf(line);
            block = [];
            continue;
        }
        block.push(line);
    }
    flush(false);

    if (cells.length === 0) cells.push({ kind: 'code', value: '', trailingBlankLines: 0 });
    return cells;
}

/** Index of the last cell of a kind, or -1. */
function lastIndexOfKind(cells: TextCell[], kind: CellKind): number {
    for (let i = cells.length - 1; i >= 0; i--) {
        if (cells[i].kind === kind) return i;
    }
    return -1;
}

/**
 * End a statement, so the next cell is not read as a continuation of it.
 *
 * Without this the file is not the script it claims to be: `clickhouse-client`
 * reads `LIMIT 10`, a comment, and the next `SELECT` as one malformed
 * statement. Only cells that are followed by more SQL need it - the last one
 * does not, so a plain single-statement script opened as a notebook and saved
 * comes back byte for byte as it was.
 */
function terminate(value: string): string {
    const trimmed = value.trimEnd();
    if (trimmed === '' || trimmed.endsWith(';')) return value;
    // Put it after the content, before whatever trailing whitespace was there.
    return trimmed + ';' + value.slice(trimmed.length);
}

/** The marker to write for a cell that never had one. */
function defaultMarker(kind: CellKind): string {
    return kind === 'markup' ? '-- %% markdown' : '-- %%';
}

/**
 * Write the file text for a notebook.
 *
 * `writeCells(parseCells(text)) === text` for any file whose markup cells use
 * the canonical `-- ` prefix, so opening and saving without editing leaves the
 * file byte for byte as it was.
 */
export function writeCells(cells: TextCell[]): string {
    const out: string[] = [];
    const lastCode = lastIndexOfKind(cells, 'code');

    cells.forEach((cell, index) => {
        // Only a leading code cell may go without a marker. A later cell needs
        // its boundary or the cells would merge on the next read, and a markup
        // cell needs one or it would come back as SQL.
        const leadingCode = index === 0 && cell.kind === 'code';
        const marker = cell.marker ?? (leadingCode ? undefined : defaultMarker(cell.kind));
        if (marker !== undefined) out.push(marker);

        const value =
            cell.kind === 'code' && index < lastCode ? terminate(cell.value) : cell.value;
        const lines = value === '' ? [] : value.split('\n');
        out.push(...(cell.kind === 'markup' ? lines.map(comment) : lines));
        for (let i = 0; i < cell.trailingBlankLines; i++) out.push('');
    });

    return out.join('\n');
}

/**
 * The marker a cell should carry once its kind is known.
 *
 * A cell that changed kind in the editor - markdown turned into SQL - must not
 * keep a marker that now says the wrong thing.
 */
export function markerFor(cell: TextCell): string | undefined {
    if (cell.marker === undefined) return undefined;
    const declared = kindOf(cell.marker);
    return declared === cell.kind ? cell.marker : defaultMarker(cell.kind);
}
