/**
 * Fuzzing the things that read whatever a user hands them.
 *
 * The parser already survives random token soup. The notebook format has the
 * same exposure and a stronger obligation: it does not merely have to avoid
 * throwing, it has to be a fixed point. If `write(parse(x))` differs from
 * `write(parse(write(parse(x))))`, then opening and saving a file twice changes
 * it twice, and a user's diff grows every time they look at it.
 */
import { parseCells, writeCells } from '../notebook/format';
import { findParameters } from '../notebook/parameters';
import { parse } from '../parser/parser';
import { tokenize } from '../lexer';
import { readTemplateCall } from '../parser/template';

/** Deterministic, so a failure is reproducible. */
function makeRandom(seed: number) {
    let state = seed;
    return () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
}

/** The pieces a notebook file is actually made of, plus things that look like them. */
const PIECES = [
    '-- %%',
    '-- %% markdown',
    '-- %% md',
    '--%%',
    '-- %%[markdown]',
    '-- %% a title',
    'SELECT 1',
    'SELECT 1;',
    'SELECT * FROM t',
    '-- a comment',
    '--',
    '',
    '   ',
    '\t',
    "SELECT '{{ not a tag }}'",
    "{{ ref('users') }}",
    '{% if x %}',
    '{# note #}',
    'SELECT {p:UInt64}',
    '/* block',
    '*/',
    '`weird name`',
    "'unterminated",
    '}}',
    '{{',
];

function soup(random: () => number, lines: number): string {
    return Array.from({ length: lines }, () => PIECES[Math.floor(random() * PIECES.length)]).join('\n');
}

describe('the notebook format under random input', () => {
    it('never throws', () => {
        const random = makeRandom(20260829);
        for (let n = 0; n < 500; n++) {
            const text = soup(random, 1 + Math.floor(random() * 12));
            expect(() => writeCells(parseCells(text))).not.toThrow();
        }
    });

    it('settles after one write, so saving twice does not change a file twice', () => {
        const random = makeRandom(7);
        for (let n = 0; n < 500; n++) {
            const text = soup(random, 1 + Math.floor(random() * 12));
            const once = writeCells(parseCells(text));
            const twice = writeCells(parseCells(once));
            expect({ text, once, twice }).toMatchObject({ twice: once });
        }
    });

    it('never loses a code cell\'s content', () => {
        // Round-tripping may add a terminator; it may not drop a statement.
        const random = makeRandom(99);
        for (let n = 0; n < 300; n++) {
            const text = soup(random, 1 + Math.floor(random() * 10));
            const before = parseCells(text).filter(cell => cell.kind === 'code');
            const after = parseCells(writeCells(parseCells(text))).filter(cell => cell.kind === 'code');
            expect({ n, before: before.length, after: after.length }).toMatchObject({ after: before.length });
        }
    });

    it('always produces a file that is only SQL and comments', () => {
        // The format's central claim: every line is a statement or a comment,
        // so `clickhouse-client` can read the whole file.
        const random = makeRandom(4242);
        for (let n = 0; n < 300; n++) {
            const cells = parseCells(soup(random, 1 + Math.floor(random() * 8)));
            for (const cell of cells) {
                if (cell.kind !== 'markup') continue;
                const written = writeCells([cell]);
                for (const line of written.split('\n')) {
                    expect({ n, line }).toMatchObject({ line: expect.stringMatching(/^\s*(--|$)/) });
                }
            }
        }
    });

    it('always leaves at least one cell to type into', () => {
        const random = makeRandom(11);
        for (let n = 0; n < 300; n++) {
            expect(parseCells(soup(random, Math.floor(random() * 6))).length).toBeGreaterThan(0);
        }
    });
});

describe('the readers that take arbitrary text', () => {
    const random = makeRandom(31337);

    it('finding parameters never throws or hangs', () => {
        for (let n = 0; n < 500; n++) {
            const text = soup(random, 1 + Math.floor(random() * 10));
            expect(() => findParameters(text)).not.toThrow();
        }
    });

    it('reading a template call never throws', () => {
        for (let n = 0; n < 500; n++) {
            const text = soup(random, 1 + Math.floor(random() * 4));
            expect(() => readTemplateCall(text)).not.toThrow();
        }
    });

    it('lexing and parsing survive whatever the format produces', () => {
        for (let n = 0; n < 300; n++) {
            const text = writeCells(parseCells(soup(random, 1 + Math.floor(random() * 10))));
            expect(() => tokenize(text)).not.toThrow();
            expect(() => parse(text)).not.toThrow();
        }
    });

    it('lexing covers the whole input, whatever is in it', () => {
        // A token that skips a character would silently drop it from the file.
        for (let n = 0; n < 300; n++) {
            const text = soup(random, 1 + Math.floor(random() * 8));
            const tokens = tokenize(text);
            expect(tokens.map(token => token.text).join('')).toBe(text);
        }
    });
});
