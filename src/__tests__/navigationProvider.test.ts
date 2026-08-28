/**
 * Tests for definition, references and rename.
 */
import { localSymbolAt } from '../providers/navigationProvider';
import { AnalysisCache } from '../analysis';
import { makeSchemaManager, makeCatalog, docAt } from './helpers';

let cache: AnalysisCache;

beforeAll(async () => {
    cache = new AnalysisCache(await makeSchemaManager(), makeCatalog());
});

/** Symbol at the `|` marker, with its occurrences rendered as text. */
function symbolAt(sql: string) {
    const { document, offset } = docAt(sql);
    const symbol = localSymbolAt(cache, document, offset);
    if (!symbol) return undefined;
    const text = document.getText();
    return {
        kind: symbol.kind,
        name: symbol.name,
        declaration: text.slice(symbol.declaration.start, symbol.declaration.end),
        declarationStart: symbol.declaration.start,
        occurrences: symbol.occurrences
            .slice()
            .sort((a, b) => a.start - b.start)
            .map(o => o.start),
    };
}

describe('CTE names', () => {
    const sql = 'WITH recent AS (SELECT event_id FROM events) SELECT * FROM recent';

    it('resolves from the declaration', () => {
        expect(symbolAt(sql.replace('recent AS', 'rece|nt AS'))).toMatchObject({ kind: 'cte', name: 'recent' });
    });

    it('resolves from a usage back to the declaration', () => {
        const marked = 'WITH recent AS (SELECT event_id FROM events) SELECT * FROM rec|ent';
        const symbol = symbolAt(marked);
        expect(symbol?.kind).toBe('cte');
        expect(symbol?.declarationStart).toBe(5);
    });

    it('finds both occurrences', () => {
        expect(symbolAt(sql.replace('recent AS', 'rece|nt AS'))?.occurrences).toHaveLength(2);
    });
});

describe('table aliases', () => {
    const sql = 'SELECT e.event_id FROM events AS e WHERE e.user_id = 1';

    it('resolves from the declaration', () => {
        const symbol = symbolAt(sql.replace('AS e WHERE', 'AS e| WHERE'));
        expect(symbol).toMatchObject({ kind: 'tableAlias', name: 'e' });
    });

    it('resolves from a qualifier usage', () => {
        const symbol = symbolAt('SELECT e|.event_id FROM events AS e WHERE e.user_id = 1');
        expect(symbol?.kind).toBe('tableAlias');
        expect(symbol?.occurrences).toHaveLength(3);
    });

    it('includes a qualified star', () => {
        const symbol = symbolAt('SELECT e|.* FROM events AS e');
        expect(symbol?.occurrences).toHaveLength(2);
    });

    it('does not confuse two different aliases', () => {
        const symbol = symbolAt('SELECT e|.event_id FROM events e JOIN users u ON e.user_id = u.user_id');
        expect(symbol?.name).toBe('e');
        expect(symbol?.occurrences).toHaveLength(3);
    });
});

describe('lambda parameters', () => {
    it('resolves a parameter and its uses', () => {
        const symbol = symbolAt('SELECT arrayMap(x| -> x + 1, tags) FROM events');
        expect(symbol).toMatchObject({ kind: 'lambdaParam', name: 'x' });
        expect(symbol?.occurrences).toHaveLength(2);
    });

    it('does not leak outside the lambda', () => {
        const symbol = symbolAt('SELECT arrayMap(x| -> x + 1, tags), x FROM events');
        expect(symbol?.occurrences).toHaveLength(2);
    });

    it('prefers the lambda parameter over an outer alias of the same name', () => {
        const symbol = symbolAt('SELECT 1 AS x, arrayMap(x -> x| + 1, tags) FROM events');
        expect(symbol?.kind).toBe('lambdaParam');
    });
});

describe('select-list aliases', () => {
    it('resolves an alias and its later use', () => {
        const symbol = symbolAt('SELECT event_id AS ei|d FROM events ORDER BY eid');
        expect(symbol).toMatchObject({ kind: 'selectAlias', name: 'eid' });
        expect(symbol?.occurrences).toHaveLength(2);
    });
});

describe('nothing to navigate', () => {
    it('returns nothing on a plain column', () => {
        expect(symbolAt('SELECT event|_id FROM events')).toBeUndefined();
    });

    it('returns nothing on a keyword', () => {
        expect(symbolAt('SEL|ECT event_id FROM events')).toBeUndefined();
    });

    it('returns nothing on an empty document', () => {
        expect(symbolAt('|')).toBeUndefined();
    });

    it('stays within the statement under the cursor', () => {
        const symbol = symbolAt('WITH c AS (SELECT 1) SELECT * FROM c; SELECT * FROM c|');
        // The second statement has no CTE named c, so nothing local resolves.
        expect(symbol).toBeUndefined();
    });
});
