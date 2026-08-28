/**
 * Tests for inlay hints.
 */
import * as vscode from 'vscode';
import { computeInlayHints } from '../providers/inlayHintsProvider';
import { AnalysisCache } from '../analysis';
import { SchemaManager } from '../schemaManager';
import { Catalog } from '../catalog';
import { makeSchemaManager, makeCatalog, docAt } from './helpers';

let cache: AnalysisCache;
let schemaManager: SchemaManager;
let catalog: Catalog;

beforeAll(async () => {
    schemaManager = await makeSchemaManager();
    catalog = makeCatalog();
    await catalog.systemTables();
    cache = new AnalysisCache(schemaManager, catalog);
});

function hintsFor(sql: string): string[] {
    const { document } = docAt(sql);
    const whole = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
    return computeInlayHints(document, whole, cache, schemaManager, catalog).map(hint => String(hint.label));
}

describe('column type hints', () => {
    it('annotates projected columns', () => {
        expect(hintsFor('SELECT event_id, user_id FROM events')).toEqual([': UInt64', ': UInt64']);
    });

    it('annotates through an alias qualifier', () => {
        expect(hintsFor('SELECT e.tags FROM events e')).toEqual([': Array(String)']);
    });

    it('annotates system table columns', () => {
        expect(hintsFor('SELECT query_duration_ms FROM system.query_log')[0]).toMatch(/^: /);
    });

    it('says nothing about an expression', () => {
        expect(hintsFor('SELECT count() FROM events')).toEqual([]);
        expect(hintsFor('SELECT event_id + 1 FROM events')).toEqual([]);
    });

    it('says nothing about a star', () => {
        expect(hintsFor('SELECT * FROM events')).toEqual([]);
    });

    it('says nothing when the table is unknown', () => {
        expect(hintsFor('SELECT anything FROM ghosts')).toEqual([]);
    });

    it('says nothing when the column is ambiguous', () => {
        expect(hintsFor('SELECT user_id FROM events JOIN users ON 1 = 1')).toEqual([]);
    });

    it('annotates inside a subquery', () => {
        expect(hintsFor('SELECT x FROM (SELECT event_id FROM events) s')).toEqual([': UInt64']);
    });

    it('places the hint right after the expression', () => {
        const { document } = docAt('SELECT event_id FROM events');
        const whole = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
        const [hint] = computeInlayHints(document, whole, cache, schemaManager, catalog);
        expect(document.offsetAt(hint.position)).toBe('SELECT event_id'.length);
    });

    it('only reports hints inside the requested range', () => {
        const { document } = docAt('SELECT event_id FROM events;\nSELECT user_id FROM events');
        const secondLine = new vscode.Range(new vscode.Position(1, 0), new vscode.Position(1, 30));
        const hints = computeInlayHints(document, secondLine, cache, schemaManager, catalog);
        expect(hints).toHaveLength(1);
    });
});
