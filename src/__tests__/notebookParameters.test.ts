/**
 * Tests for runbook parameters.
 *
 * Two things matter here. Finding a placeholder must not fire on something that
 * merely looks like one - a Map literal in a string is not a parameter - and a
 * value must never be interpolated into the SQL, because a date typed into a
 * box would then be an injection.
 */
import { findParameters, ParameterStore, suggestValue } from '../notebook/parameters';

describe('finding placeholders', () => {
    it('finds one, with its declared type', () => {
        expect(findParameters('SELECT * FROM t WHERE d >= {start:Date}')).toEqual([
            { name: 'start', type: 'Date' },
        ]);
    });

    it('finds several, in the order they appear', () => {
        expect(
            findParameters('SELECT {a:UInt64}, {b:String} FROM t WHERE c = {c:Float64}').map(p => p.name)
        ).toEqual(['a', 'b', 'c']);
    });

    it('mentions a repeated placeholder once', () => {
        expect(findParameters('SELECT {d:Date}, {d:Date}')).toEqual([{ name: 'd', type: 'Date' }]);
    });

    it('accepts a parameterised type', () => {
        expect(findParameters("SELECT {ts:DateTime64(3)}")[0].type).toBe('DateTime64(3)');
        expect(findParameters('SELECT {x:Decimal(18, 4)}')[0].type).toBe('Decimal(18, 4)');
    });

    it('tolerates the spacing people actually write', () => {
        expect(findParameters('SELECT { start : Date }')).toEqual([{ name: 'start', type: 'Date' }]);
    });

    it('ignores a map literal, which is the thing most likely to look like one', () => {
        expect(findParameters("SELECT map('a', 1), {'k': 'v'}")).toEqual([]);
        expect(findParameters('SELECT {1: 2}')).toEqual([]);
    });

    it('ignores what is inside a string', () => {
        expect(findParameters("SELECT 'not {a:Date} a parameter'")).toEqual([]);
        expect(findParameters('SELECT "not {a:Date}"')).toEqual([]);
        expect(findParameters("SELECT 'escaped \\' {a:Date}'")).toEqual([]);
    });

    it('ignores what is inside a comment', () => {
        expect(findParameters('SELECT 1 -- {a:Date}\n')).toEqual([]);
        expect(findParameters('SELECT 1 /* {a:Date} */')).toEqual([]);
    });

    it('still finds the real one alongside a decoy', () => {
        expect(findParameters("SELECT '{fake:Date}', {real:Date} -- {alsofake:Date}")).toEqual([
            { name: 'real', type: 'Date' },
        ]);
    });

    it('finds nothing in a query that has none', () => {
        expect(findParameters('SELECT count() FROM events')).toEqual([]);
    });
});

describe('suggested values', () => {
    it('offers today for a date, so the box is not empty', () => {
        expect(suggestValue('Date')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(suggestValue('DateTime')).toMatch(/^\d{4}-\d{2}-\d{2} 00:00:00$/);
        expect(suggestValue('DateTime64(3)')).toMatch(/^\d{4}-\d{2}-\d{2} 00:00:00$/);
    });

    it('offers zero for a number and nothing for a string', () => {
        expect(suggestValue('UInt64')).toBe('0');
        expect(suggestValue('Float64')).toBe('0');
        expect(suggestValue('Decimal(18, 4)')).toBe('0');
        expect(suggestValue('String')).toBe('');
    });

    it('offers something plausible for the rest', () => {
        expect(suggestValue('Bool')).toBe('true');
        expect(suggestValue('Array(UInt64)')).toBe('[]');
    });
});

describe('remembering values', () => {
    const A = 'file:///w/a.runbook.sql';
    const B = 'file:///w/b.runbook.sql';

    it('keeps them per notebook, so two runbooks do not share a window', () => {
        const store = new ParameterStore();
        store.set(A, 'start', '2026-01-01');
        store.set(B, 'start', '2026-06-01');
        expect(store.values(A)).toEqual({ start: '2026-01-01' });
        expect(store.values(B)).toEqual({ start: '2026-06-01' });
    });

    it('reports only what is still missing', () => {
        const store = new ParameterStore();
        store.set(A, 'start', '2026-01-01');
        const wanted = [
            { name: 'start', type: 'Date' },
            { name: 'end', type: 'Date' },
        ];
        expect(store.missing(A, wanted).map(p => p.name)).toEqual(['end']);
    });

    it('treats an empty answer as an answer, not as unset', () => {
        // An empty string is a legitimate value for a String parameter, and
        // asking again every run would be maddening.
        const store = new ParameterStore();
        store.set(A, 'kind', '');
        expect(store.missing(A, [{ name: 'kind', type: 'String' }])).toEqual([]);
        expect(store.values(A)).toEqual({ kind: '' });
    });

    it('clears one notebook without touching another', () => {
        const store = new ParameterStore();
        store.set(A, 'start', 'x');
        store.set(B, 'start', 'y');
        store.clear(A);
        expect(store.values(A)).toEqual({});
        expect(store.values(B)).toEqual({ start: 'y' });
    });

    it('forgets everything when the extension shuts down', () => {
        // Values live for the session only, the same rule the outputs follow:
        // the window someone looked at during an incident is not committed.
        const store = new ParameterStore();
        store.set(A, 'start', 'x');
        store.forget();
        expect(store.values(A)).toEqual({});
    });
});
