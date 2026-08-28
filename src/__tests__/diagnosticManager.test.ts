/**
 * Tests for diagnostic scheduling.
 */
import * as vscode from 'vscode';
import { DiagnosticManager } from '../providers/diagnosticProvider';
import { SchemaManager } from '../schemaManager';
import { makeSchemaManager, makeCatalog, docAt } from './helpers';
import { AnalysisCache } from '../analysis';
import { Catalog } from '../catalog';

/** The mock document's version is writable; the public type says otherwise. */
function setVersion(document: vscode.TextDocument, version: number): void {
    (document as unknown as { version: number }).version = version;
}

let schemaManager: SchemaManager;
let catalog: Catalog;

beforeAll(async () => {
    schemaManager = await makeSchemaManager();
    catalog = makeCatalog();
});

/** A manager wired to a fresh analysis cache. */
function makeManager(collection: FakeCollection): DiagnosticManager {
    return new DiagnosticManager(
        collection as unknown as vscode.DiagnosticCollection,
        new AnalysisCache(schemaManager, catalog),
        schemaManager,
        catalog
    );
}

interface FakeCollection {
    set: jest.Mock;
    delete: jest.Mock;
    dispose: jest.Mock;
}

function makeCollection(): FakeCollection {
    return { set: jest.fn(), delete: jest.fn(), dispose: jest.fn() };
}

beforeEach(() => {
    jest.useFakeTimers();
});

afterEach(() => {
    jest.useRealTimers();
});

describe('DiagnosticManager', () => {
    it('waits for the debounce before analysing', () => {
        const collection = makeCollection();
        const manager = makeManager(collection);
        const { document } = docAt('SELECT * FROM ghosts');

        manager.schedule(document);
        expect(collection.set).not.toHaveBeenCalled();

        jest.advanceTimersByTime(300);
        expect(collection.set).toHaveBeenCalledTimes(1);
        manager.dispose();
    });

    it('collapses a burst of edits into one run', () => {
        const collection = makeCollection();
        const manager = makeManager(collection);
        const { document } = docAt('SELECT * FROM ghosts');

        for (let i = 0; i < 10; i++) {
            setVersion(document, i + 1);
            manager.schedule(document);
            jest.advanceTimersByTime(50);
        }
        expect(collection.set).not.toHaveBeenCalled();

        jest.advanceTimersByTime(300);
        expect(collection.set).toHaveBeenCalledTimes(1);
        manager.dispose();
    });

    it('drops a run that a newer edit has superseded', () => {
        const collection = makeCollection();
        const manager = makeManager(collection);
        const { document } = docAt('SELECT * FROM ghosts');

        manager.schedule(document);
        setVersion(document, 99); // edited while the timer was pending
        jest.advanceTimersByTime(300);

        expect(collection.set).not.toHaveBeenCalled();
        manager.dispose();
    });

    it('clears diagnostics for a closed document', () => {
        const collection = makeCollection();
        const manager = makeManager(collection);
        const { document } = docAt('SELECT * FROM ghosts');

        manager.schedule(document);
        manager.clear(document);
        jest.advanceTimersByTime(300);

        expect(collection.set).not.toHaveBeenCalled();
        expect(collection.delete).toHaveBeenCalledWith(document.uri);
        manager.dispose();
    });

    it('cancels pending work on dispose', () => {
        const collection = makeCollection();
        const manager = makeManager(collection);
        const { document } = docAt('SELECT * FROM ghosts');

        manager.schedule(document);
        manager.dispose();
        jest.advanceTimersByTime(300);

        expect(collection.set).not.toHaveBeenCalled();
    });

    it('runs immediately when asked to', () => {
        const collection = makeCollection();
        const manager = makeManager(collection);
        const { document } = docAt('SELECT * FROM ghosts');

        manager.run(document);
        expect(collection.set).toHaveBeenCalledTimes(1);
        manager.dispose();
    });
});
