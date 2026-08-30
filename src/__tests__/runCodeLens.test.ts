/**
 * Tests for the actions above each statement.
 *
 * A lens is the most visible thing in the extension and the easiest to get
 * subtly wrong: one that offers to do something impossible, or that hides the
 * fact that a statement is destructive, is worse than no lens at all.
 */
import * as vscode from 'vscode';
import { registerRunCodeLens } from '../client/runCommands';
import { AnalysisCache } from '../analysis';
import { Catalog } from '../catalog';
import { docAt, makeCatalog, makeSchemaManager } from './helpers';

let analysisCache: AnalysisCache;
let catalog: Catalog;

beforeAll(async () => {
    catalog = makeCatalog();
    await catalog.systemTables();
    analysisCache = new AnalysisCache(await makeSchemaManager(), catalog);
});

const setConfig = (vscode as unknown as { __setConfig(v: Record<string, unknown>): void }).__setConfig;

interface Lens {
    range: vscode.Range;
    command?: { command: string; title: string; arguments?: unknown[] };
}

/** The lenses the provider offers for this SQL. */
function lensesFor(sql: string, config: Record<string, unknown> = {}): Lens[] {
    setConfig(config);
    let provider: vscode.CodeLensProvider | undefined;
    (vscode.languages.registerCodeLensProvider as jest.Mock).mockImplementation(
        (_selector: unknown, given: vscode.CodeLensProvider) => {
            provider = given;
            return { dispose: jest.fn() };
        }
    );
    registerRunCodeLens(analysisCache);

    const { document } = docAt(sql);
    const result = provider!.provideCodeLenses(document, {} as vscode.CancellationToken);
    return (result as Lens[]) ?? [];
}

const titles = (sql: string, config?: Record<string, unknown>) =>
    lensesFor(sql, config).map(lens => lens.command?.title ?? '');

beforeEach(() => {
    jest.clearAllMocks();
    (vscode as unknown as { __resetConfig(): void }).__resetConfig();
});

describe('the actions above a statement', () => {
    it('offers Run and Explain on a query', () => {
        expect(titles('SELECT 1')).toEqual(['$(play) Run SELECT', '$(list-tree) Explain']);
    });

    it('offers a pair per statement', () => {
        expect(titles('SELECT 1;\nSELECT 2;')).toEqual([
            '$(play) Run SELECT',
            '$(list-tree) Explain',
            '$(play) Run SELECT',
            '$(list-tree) Explain',
        ]);
    });

    it('warns in the lens itself when a statement is destructive', () => {
        // Before anyone clicks it, not after.
        expect(titles('DROP TABLE events')).toEqual(['$(warning) Run DROP TABLE events']);
    });

    it('does not offer to explain a statement EXPLAIN has nothing to say about', () => {
        // A lens that errors when clicked is worse than no lens.
        expect(titles('DROP TABLE events')).not.toContain('$(list-tree) Explain');
        expect(titles('INSERT INTO t VALUES (1)')).not.toContain('$(list-tree) Explain');
        expect(titles('TRUNCATE TABLE t')).not.toContain('$(list-tree) Explain');
    });

    it('points each action at the statement it sits above, not at the cursor', () => {
        const sql = 'SELECT 1;\nSELECT 2;';
        const lenses = lensesFor(sql);
        const offsets = lenses.map(lens => lens.command?.arguments?.[1]);
        expect(offsets).toEqual([0, 0, sql.indexOf('SELECT 2'), sql.indexOf('SELECT 2')]);
    });

    it('calls the offset commands, which take a document rather than the active editor', () => {
        const commands = lensesFor('SELECT 1').map(lens => lens.command?.command);
        expect(commands).toEqual(['clickhouse.runStatementAt', 'clickhouse.explainStatementAt']);
    });

    it('explains what Explain does, since it is not obvious that it is free', () => {
        const explain = lensesFor('SELECT 1')[1] as Lens & { command: { tooltip?: string } };
        expect(explain.command.tooltip).toContain('without running');
    });
});

describe('turning the actions off', () => {
    it('drops Run but keeps Explain', () => {
        expect(titles('SELECT 1', { 'query.showRunCodeLens': false })).toEqual(['$(list-tree) Explain']);
    });

    it('drops Explain but keeps Run', () => {
        expect(titles('SELECT 1', { 'query.showExplainCodeLens': false })).toEqual(['$(play) Run SELECT']);
    });

    it('does no work at all when both are off', () => {
        expect(
            titles('SELECT 1', { 'query.showRunCodeLens': false, 'query.showExplainCodeLens': false })
        ).toEqual([]);
    });
});

describe('when the document does not parse', () => {
    it('still offers what it can rather than throwing', () => {
        expect(() => lensesFor('SELECT FROM WHERE )))')).not.toThrow();
    });

    it('offers nothing for an empty document', () => {
        expect(titles('')).toEqual([]);
    });
});
