/**
 * Tests for Preview Rows.
 *
 * A preview is a query someone will want to change — add a WHERE, raise the
 * limit, pick columns. Running it with the text hidden makes the obvious next
 * step impossible, so the statement is opened as SQL and then run.
 */
import * as vscode from 'vscode';
import { registerExplorerCommands, previewStatement } from '../client/explorerCommands';
import { ConnectionManager } from '../client/connectionManager';
import { QueryRunner } from '../client/queryRunner';
import { AnalysisCache } from '../analysis';
import { SchemaSync } from '../client/schemaSync';
import { ExplorerProvider } from '../client/explorerView';
import { SchemaTable } from '../types';

function harness() {
    const registered = new Map<string, (...args: unknown[]) => unknown>();
    (vscode.commands.registerCommand as jest.Mock).mockImplementation(
        (id: string, handler: (...args: unknown[]) => unknown) => {
            registered.set(id, handler);
            return { dispose: jest.fn() };
        }
    );

    const ran: Array<{ sql: string }> = [];
    registerExplorerCommands(
        {} as unknown as ExplorerProvider,
        { run: async (target: { sql: string }) => void ran.push(target) } as unknown as QueryRunner,
        { analyze: () => ({ program: { statements: [] } }) } as unknown as AnalysisCache,
        {} as unknown as SchemaSync,
        { client: async () => undefined } as unknown as ConnectionManager
    );
    return { command: registered.get('clickhouse.previewTable')!, ran };
}

const node = {
    kind: 'table' as const,
    database: 'demo',
    table: { name: 'events', columns: [] } as unknown as SchemaTable,
};

describe('Preview Rows', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (vscode.workspace.openTextDocument as jest.Mock).mockResolvedValue({ uri: vscode.Uri.file('/preview.sql') });
    });

    it('still runs the query, which is what it was for', async () => {
        const { command, ran } = harness();
        await command(node);

        expect(ran).toHaveLength(1);
        expect(ran[0].sql).toContain('SELECT * FROM demo.events');
    });

    it('opens the statement as ClickHouse SQL, so it can be read and changed', async () => {
        const { command } = harness();
        await command(node);

        expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(
            expect.objectContaining({
                content: expect.stringContaining('SELECT * FROM demo.events'),
                language: 'clickhouse',
            })
        );
    });

    it('opens the query where it can be edited, not as a preview tab', async () => {
        // A preview tab is replaced by the next thing opened, which would take
        // the query away the moment anything else is clicked.
        const { command } = harness();
        await command(node);

        expect(vscode.window.showTextDocument).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ preview: false })
        );
    });

    it('runs exactly the text it opened, so re-running changes nothing on its own', async () => {
        const { command, ran } = harness();
        await command(node);

        const opened = (vscode.workspace.openTextDocument as jest.Mock).mock.calls[0][0] as { content: string };
        expect(opened.content.trim()).toBe(ran[0].sql.trim());
    });

    it('ignores anything that is not a table', async () => {
        const { command, ran } = harness();
        await command({ kind: 'database', name: 'demo' });

        expect(ran).toHaveLength(0);
        expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
    });
});

describe('previewStatement', () => {
    it('limits the rows it asks for', () => {
        expect(previewStatement('demo', 'events', 25)).toBe('SELECT * FROM demo.events LIMIT 25');
    });

    it('quotes a name that needs it', () => {
        expect(previewStatement('demo', 'odd name', 10)).toContain('`odd name`');
    });
});
