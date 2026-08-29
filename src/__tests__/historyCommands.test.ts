/**
 * Tests for the history picker and for clearing.
 *
 * These drive the quick pick the way a person does - press the pin button,
 * accept an item, dismiss it - because that is where the interesting behaviour
 * lives: the list has to stay open across a pin, and clearing must not quietly
 * discard what was deliberately kept.
 */
import * as vscode from 'vscode';
import { registerHistoryCommands } from '../client/historyCommands';
import { QueryHistory } from '../client/history';
import { ConnectionManager } from '../client/connectionManager';
import { QueryRunner } from '../client/queryRunner';
import { AnalysisCache } from '../analysis';
import { LiveValidator } from '../client/liveDiagnostics';
import { Catalog } from '../catalog';
import { makeSchemaManager, makeCatalog } from './helpers';
import { makeQuickPick } from './mocks/vscode';

type Picker = ReturnType<typeof makeQuickPick>;

let analysisCache: AnalysisCache;
let catalog: Catalog;

beforeAll(async () => {
    catalog = makeCatalog();
    await catalog.systemTables();
    analysisCache = new AnalysisCache(await makeSchemaManager(), catalog);
});

function makeContext() {
    const state: Record<string, unknown> = {};
    return {
        subscriptions: [],
        workspaceState: {
            get: (key: string, fallback?: unknown) => (key in state ? state[key] : fallback),
            update: async (key: string, value: unknown) => {
                state[key] = value;
            },
        },
        secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined },
    } as unknown as vscode.ExtensionContext;
}

/** Register the commands and hand back the handlers by name. */
function commandsFor(history: QueryHistory) {
    const handlers = new Map<string, (...args: unknown[]) => Promise<void>>();
    (vscode.commands.registerCommand as jest.Mock).mockImplementation(
        (name: string, handler: (...args: unknown[]) => Promise<void>) => {
            handlers.set(name, handler);
            return { dispose: jest.fn() };
        }
    );
    const run = jest.fn(async () => undefined);
    registerHistoryCommands(
        history,
        { run } as unknown as QueryRunner,
        new ConnectionManager(makeContext()),
        analysisCache,
        {} as LiveValidator
    );
    return { handlers, run };
}

/** The next quick pick the code under test creates. */
function captureQuickPick(): { current(): Picker } {
    let picker: Picker | undefined;
    (vscode.window.createQuickPick as jest.Mock).mockImplementation(() => (picker = makeQuickPick()));
    return {
        current: () => {
            if (!picker) throw new Error('no quick pick was shown');
            return picker;
        },
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    (vscode as unknown as { __resetConfig(): void }).__resetConfig();
});

describe('the history picker', () => {
    async function withTwoEntries() {
        const history = new QueryHistory(makeContext());
        await history.record({ sql: 'SELECT 1', profile: 'p', queryId: 'one', at: 1 });
        await history.record({ sql: 'SELECT 2', profile: 'p', queryId: 'two', at: 2 });
        return history;
    }

    it('says so when nothing has been run, without opening a picker', async () => {
        const { handlers } = commandsFor(new QueryHistory(makeContext()));
        await handlers.get('clickhouse.showQueryHistory')!();
        expect(vscode.window.createQuickPick).not.toHaveBeenCalled();
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('no queries'));
    });

    it('runs the entry that was chosen, not the one at that position', async () => {
        // The picker filters and reorders, so position is not identity.
        const history = await withTwoEntries();
        const { handlers, run } = commandsFor(history);
        const pick = captureQuickPick();

        const showing = handlers.get('clickhouse.showQueryHistory')!();
        const older = pick.current().items.find(
            item => (item as { entry?: { queryId: string } }).entry?.queryId === 'one'
        );
        await pick.current().accept(older);
        await showing;

        expect(run).toHaveBeenCalledWith(expect.objectContaining({ sql: 'SELECT 1' }));
    });

    it('runs nothing when dismissed', async () => {
        const { handlers, run } = commandsFor(await withTwoEntries());
        const pick = captureQuickPick();

        const showing = handlers.get('clickhouse.showQueryHistory')!();
        pick.current().hide();
        await showing;

        expect(run).not.toHaveBeenCalled();
        expect(pick.current().dispose).toHaveBeenCalled();
    });

    it('pins from the button and stays open, keeping what was typed', async () => {
        const history = await withTwoEntries();
        const { handlers, run } = commandsFor(history);
        const pick = captureQuickPick();

        const showing = handlers.get('clickhouse.showQueryHistory')!();
        pick.current().value = 'SELECT';
        const target = pick.current().items.find(
            item => (item as { entry?: { queryId: string } }).entry?.queryId === 'one'
        );
        await pick.current().triggerItemButton(target);

        expect(history.pinned().map(entry => entry.queryId)).toEqual(['one']);
        expect(pick.current().hide).not.toHaveBeenCalled();
        expect(pick.current().value).toBe('SELECT');
        // The pinned entry now heads the list, under its own separator.
        expect((pick.current().items[0] as vscode.QuickPickItem).label).toBe('Pinned');

        pick.current().hide();
        await showing;
        expect(run).not.toHaveBeenCalled();
    });

    it('unpins from the same button', async () => {
        const history = await withTwoEntries();
        await history.setPinned('one', true);
        const { handlers } = commandsFor(history);
        const pick = captureQuickPick();

        const showing = handlers.get('clickhouse.showQueryHistory')!();
        const target = pick.current().items.find(
            item => (item as { entry?: { queryId: string } }).entry?.queryId === 'one'
        );
        await pick.current().triggerItemButton(target);
        expect(history.pinned()).toEqual([]);

        pick.current().hide();
        await showing;
    });

    it('ignores a button press on a separator', async () => {
        const history = await withTwoEntries();
        await history.setPinned('one', true);
        const { handlers } = commandsFor(history);
        const pick = captureQuickPick();

        const showing = handlers.get('clickhouse.showQueryHistory')!();
        await pick.current().triggerItemButton(pick.current().items[0]);
        expect(history.pinned().length).toBe(1);

        pick.current().hide();
        await showing;
    });

    it('shows a pin label instead of the raw SQL', async () => {
        const history = await withTwoEntries();
        await history.setPinned('one', true, 'daily rollup');
        const { handlers } = commandsFor(history);
        const pick = captureQuickPick();

        const showing = handlers.get('clickhouse.showQueryHistory')!();
        const labels = pick.current().items.map(item => (item as vscode.QuickPickItem).label);
        expect(labels).toContain('daily rollup');
        // The SQL is still findable, moved to the description.
        const pinned = pick.current().items.find(item => (item as vscode.QuickPickItem).label === 'daily rollup');
        expect((pinned as vscode.QuickPickItem).description).toContain('SELECT 1');

        pick.current().hide();
        await showing;
    });
});

describe('clearing history', () => {
    it('clears without asking when there is nothing pinned', async () => {
        const history = new QueryHistory(makeContext());
        await history.record({ sql: 'SELECT 1', profile: 'p', queryId: 'one', at: 1 });
        const { handlers } = commandsFor(history);

        await handlers.get('clickhouse.clearQueryHistory')!();
        expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
        expect(history.entries()).toEqual([]);
    });

    it('keeps the pins when asked to', async () => {
        const history = new QueryHistory(makeContext());
        await history.record({ sql: 'SELECT 1', profile: 'p', queryId: 'one', at: 1 });
        await history.record({ sql: 'SELECT 2', profile: 'p', queryId: 'two', at: 2 });
        await history.setPinned('one', true);
        const { handlers } = commandsFor(history);
        (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Keep 1 pinned');

        await handlers.get('clickhouse.clearQueryHistory')!();
        expect(history.entries().map(entry => entry.queryId)).toEqual(['one']);
    });

    it('discards them when that is what was chosen', async () => {
        const history = new QueryHistory(makeContext());
        await history.record({ sql: 'SELECT 1', profile: 'p', queryId: 'one', at: 1 });
        await history.setPinned('one', true);
        const { handlers } = commandsFor(history);
        (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Clear everything');

        await handlers.get('clickhouse.clearQueryHistory')!();
        expect(history.entries()).toEqual([]);
    });

    it('leaves everything alone when the confirmation is dismissed', async () => {
        const history = new QueryHistory(makeContext());
        await history.record({ sql: 'SELECT 1', profile: 'p', queryId: 'one', at: 1 });
        await history.record({ sql: 'SELECT 2', profile: 'p', queryId: 'two', at: 2 });
        await history.setPinned('one', true);
        const { handlers } = commandsFor(history);
        (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);

        await handlers.get('clickhouse.clearQueryHistory')!();
        expect(history.entries().length).toBe(2);
    });
});
