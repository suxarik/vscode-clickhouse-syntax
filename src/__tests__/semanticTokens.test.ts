/**
 * Tests for semantic highlighting.
 */
import { collectSemanticTokens, SEMANTIC_TOKENS_LEGEND } from '../providers/semanticTokensProvider';
import { AnalysisCache } from '../analysis';
import { Catalog } from '../catalog';
import { makeSchemaManager, makeCatalog, docAt } from './helpers';

let cache: AnalysisCache;
let catalog: Catalog;

beforeAll(async () => {
    catalog = makeCatalog();
    cache = new AnalysisCache(await makeSchemaManager(), catalog);
});

/** `text -> type` for every semantic token in the query. */
function tokensOf(sql: string): Array<[string, string]> {
    const { document } = docAt(sql);
    const text = document.getText();
    return collectSemanticTokens(document, cache, catalog).map(token => [
        text.slice(token.start, token.end),
        token.type,
    ]);
}

describe('classification', () => {
    it('separates tables, columns and aliases', () => {
        const tokens = tokensOf('SELECT e.event_id FROM analytics.events AS e');
        expect(tokens).toContainEqual(['analytics', 'namespace']);
        expect(tokens).toContainEqual(['events', 'class']);
        expect(tokens).toContainEqual(['e', 'variable']);
        expect(tokens).toContainEqual(['event_id', 'property']);
    });

    it('marks functions', () => {
        expect(tokensOf('SELECT count() FROM events')).toContainEqual(['count', 'function']);
    });

    it('marks lambda parameters', () => {
        const tokens = tokensOf('SELECT arrayMap(x -> x + 1, tags) FROM events');
        expect(tokens.filter(([text, type]) => text === 'x' && type === 'parameter')).toHaveLength(2);
    });

    it('marks CTE names as classes', () => {
        const tokens = tokensOf('WITH recent AS (SELECT 1) SELECT * FROM recent');
        expect(tokens.filter(([text, type]) => text === 'recent' && type === 'class')).toHaveLength(2);
    });

    it('marks column definitions', () => {
        const tokens = tokensOf('CREATE TABLE t (a UInt64) ENGINE = Memory');
        expect(tokens).toContainEqual(['a', 'property']);
    });

    it('marks settings', () => {
        expect(tokensOf('SELECT 1 SETTINGS max_threads = 4')).toContainEqual(['max_threads', 'property']);
    });

    it('marks a select alias as a variable', () => {
        expect(tokensOf('SELECT event_id AS eid FROM events')).toContainEqual(['eid', 'variable']);
    });
});

describe('modifiers', () => {
    function modifiersFor(sql: string, text: string): string[] {
        const { document } = docAt(sql);
        const source = document.getText();
        const token = collectSemanticTokens(document, cache, catalog).find(
            t => source.slice(t.start, t.end) === text
        );
        return token?.modifiers ?? [];
    }

    it('marks declarations', () => {
        expect(modifiersFor('SELECT a FROM events AS e', 'e')).toContain('declaration');
    });

    it('marks catalog functions as library functions', () => {
        expect(modifiersFor('SELECT count()', 'count')).toContain('defaultLibrary');
        expect(modifiersFor('SELECT my_udf()', 'my_udf')).not.toContain('defaultLibrary');
    });

    it('marks system tables as library tables', () => {
        expect(modifiersFor('SELECT a FROM system.parts', 'parts')).toContain('defaultLibrary');
    });
});

describe('output shape', () => {
    it('declares a legend covering every emitted type', () => {
        const tokens = tokensOf('SELECT e.event_id, count() FROM analytics.events AS e');
        for (const [, type] of tokens) {
            expect(SEMANTIC_TOKENS_LEGEND.tokenTypes).toContain(type);
        }
    });

    it('emits tokens in order and without overlaps', () => {
        const { document } = docAt('SELECT e.event_id, count(x) FROM analytics.events AS e WHERE e.user_id = 1');
        const tokens = collectSemanticTokens(document, cache, catalog);
        for (let i = 1; i < tokens.length; i++) {
            expect(tokens[i].start).toBeGreaterThanOrEqual(tokens[i - 1].end);
        }
    });

    it('emits nothing for an empty document', () => {
        expect(tokensOf('')).toEqual([]);
    });
});
