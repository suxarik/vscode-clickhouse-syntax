/**
 * Tests for outline, folding and smart-select.
 */
import * as vscode from 'vscode';
import { documentSymbols, foldingRanges, selectionRanges } from '../providers/structureProvider';
import { AnalysisCache } from '../analysis';
import { makeSchemaManager, makeCatalog, docAt } from './helpers';

let cache: AnalysisCache;

beforeAll(async () => {
    cache = new AnalysisCache(await makeSchemaManager(), makeCatalog());
});

function symbols(sql: string) {
    const { document } = docAt(sql);
    return documentSymbols(document, cache);
}

describe('document symbols', () => {
    it('lists one symbol per statement', () => {
        const result = symbols('SELECT a FROM events;\nSELECT b FROM users;');
        expect(result).toHaveLength(2);
        expect(result[0].name).toBe('SELECT');
        expect(result[0].detail).toBe('from events');
    });

    it('nests CTEs under their query', () => {
        const result = symbols('WITH recent AS (SELECT event_id FROM events) SELECT * FROM recent');
        expect(result[0].children.map(c => c.name)).toEqual(['recent']);
        expect(result[0].children[0].detail).toBe('from events');
    });

    it('nests a CTE declared inside another CTE', () => {
        const result = symbols('WITH outer_c AS (WITH inner_c AS (SELECT 1) SELECT * FROM inner_c) SELECT * FROM outer_c');
        expect(result[0].children[0].name).toBe('outer_c');
        expect(result[0].children[0].children.map(c => c.name)).toEqual(['inner_c']);
    });

    it('lists columns under CREATE TABLE', () => {
        const result = symbols('CREATE TABLE db.t (a UInt64, b String) ENGINE = MergeTree ORDER BY a');
        expect(result[0].name).toBe('TABLE db.t');
        expect(result[0].detail).toBe('MergeTree');
        expect(result[0].children.map(c => `${c.name}:${c.detail}`)).toEqual(['a:UInt64', 'b:String']);
    });

    it('names other statement kinds', () => {
        expect(symbols('INSERT INTO t VALUES (1)')[0].name).toBe('INSERT INTO t');
        expect(symbols('CREATE MATERIALIZED VIEW mv TO d AS SELECT 1')[0].name).toBe('MATERIALIZED VIEW mv');
        expect(symbols('ALTER TABLE t DROP COLUMN c')[0].name).toBe('ALTER TABLE t');
        expect(symbols('DROP TABLE t')[0].name).toBe('DROP TABLE t');
        expect(symbols('SYSTEM RELOAD DICTIONARIES')[0].name).toContain('SYSTEM');
    });

    it('keeps the selection range inside the full range', () => {
        for (const symbol of symbols('CREATE TABLE db.t (a UInt64) ENGINE = Memory')) {
            expect(symbol.range.contains(symbol.selectionRange)).toBe(true);
            for (const child of symbol.children) {
                expect(child.range.contains(child.selectionRange)).toBe(true);
            }
        }
    });
});

describe('folding ranges', () => {
    function folds(sql: string) {
        const { document } = docAt(sql);
        return foldingRanges(document, cache);
    }

    it('folds a multi-line statement', () => {
        const ranges = folds('SELECT\n  a,\n  b\nFROM events');
        expect(ranges.some(r => r.start === 0 && r.end === 3)).toBe(true);
    });

    it('folds a parenthesised subquery', () => {
        const ranges = folds('SELECT a FROM events\nWHERE id IN (\n  SELECT 1\n)');
        expect(ranges.some(r => r.start === 1 && r.end === 3)).toBe(true);
    });

    it('folds a run of line comments', () => {
        const ranges = folds('-- one\n-- two\n-- three\nSELECT 1');
        expect(ranges.some(r => r.start === 0 && r.end === 2 && r.kind === vscode.FoldingRangeKind.Comment)).toBe(
            true
        );
    });

    it('folds a block comment', () => {
        const ranges = folds('/*\n  note\n*/\nSELECT 1');
        expect(ranges.some(r => r.kind === vscode.FoldingRangeKind.Comment)).toBe(true);
    });

    it('does not fold a single line', () => {
        expect(folds('SELECT a FROM events')).toEqual([]);
    });
});

describe('selection ranges', () => {
    /** Widening chain of selected texts at the `|` marker. */
    function chain(sql: string): string[] {
        const { document, position } = docAt(sql);
        const [selection] = selectionRanges(document, [position], cache);
        const texts: string[] = [];
        for (let current: vscode.SelectionRange | undefined = selection; current; current = current.parent) {
            texts.push(document.getText(current.range));
        }
        return texts;
    }

    it('widens from an identifier outwards', () => {
        const texts = chain('SELECT a FROM events WHERE user_i|d = 1');
        expect(texts[0]).toBe('user_id');
        expect(texts).toContain('user_id = 1');
        expect(texts[texts.length - 1]).toBe('SELECT a FROM events WHERE user_id = 1');
    });

    it('widens through nested calls', () => {
        const texts = chain('SELECT toDate(toString(x|)) FROM events');
        expect(texts[0]).toBe('x');
        expect(texts).toContain('toString(x)');
        expect(texts).toContain('toDate(toString(x))');
    });

    it('produces strictly widening ranges', () => {
        const { document, position } = docAt('SELECT a FROM events WHERE user_i|d = 1');
        const [selection] = selectionRanges(document, [position], cache);
        let previous: vscode.SelectionRange | undefined;
        for (let current: vscode.SelectionRange | undefined = selection; current; current = current.parent) {
            if (previous) expect(current.range.contains(previous.range)).toBe(true);
            previous = current;
        }
    });
});
