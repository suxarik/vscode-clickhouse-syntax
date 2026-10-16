/**
 * Tests for Show Create Table.
 */
import * as vscode from 'vscode';
import { registerExplorerCommands } from '../client/explorerCommands';
import { ConnectionManager } from '../client/connectionManager';
import { QueryRunner } from '../client/queryRunner';
import { AnalysisCache } from '../analysis';
import { SchemaSync } from '../client/schemaSync';
import { ExplorerProvider } from '../client/explorerView';
import { SchemaTable } from '../types';

const DDL = `CREATE TABLE demo.events_local
(
    \`event_date\` Date,
    \`user_id\` UInt64
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/events', '{replica}')
ORDER BY (event_date, user_id)`;

/** Registers the commands and hands back the one under test. */
function commandFor(name: string, client: unknown) {
    const registered = new Map<string, (...args: unknown[]) => unknown>();
    (vscode.commands.registerCommand as jest.Mock).mockImplementation(
        (id: string, handler: (...args: unknown[]) => unknown) => {
            registered.set(id, handler);
            return { dispose: jest.fn() };
        }
    );

    registerExplorerCommands(
        {} as unknown as ExplorerProvider,
        {} as unknown as QueryRunner,
        {} as unknown as AnalysisCache,
        {} as unknown as SchemaSync,
        { client: async () => client } as unknown as ConnectionManager
    );
    return registered.get(name)!;
}

const node = {
    kind: 'table' as const,
    database: 'demo',
    table: { name: 'events_local', columns: [] } as unknown as SchemaTable,
};

describe('Show Create Table', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (vscode.workspace.openTextDocument as jest.Mock).mockResolvedValue({ uri: vscode.Uri.file('/ddl.sql') });
    });

    it('opens the statement as SQL, not as a one-cell result', () => {
        const command = commandFor('clickhouse.showCreateTable', {
            query: async () => ({ columns: [{ name: 'statement', type: 'String' }], rows: [[DDL]] }),
        });
        return Promise.resolve(command(node)).then(() => {
            expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(
                expect.objectContaining({ content: expect.stringContaining('CREATE TABLE'), language: 'clickhouse' })
            );
        });
    });

    it('keeps the line breaks, which is the whole reason a grid cell will not do', () => {
        const command = commandFor('clickhouse.showCreateTable', {
            query: async () => ({ columns: [{ name: 'statement', type: 'String' }], rows: [[DDL]] }),
        });
        return Promise.resolve(command(node)).then(() => {
            const argument = (vscode.workspace.openTextDocument as jest.Mock).mock.calls[0][0] as {
                content: string;
            };
            expect(argument.content.split('\n').length).toBeGreaterThan(4);
            expect(argument.content).toContain('ENGINE = ReplicatedMergeTree');
        });
    });

    it('says so rather than opening an empty editor when nothing comes back', () => {
        const command = commandFor('clickhouse.showCreateTable', {
            query: async () => ({ columns: [{ name: 'statement', type: 'String' }], rows: [] }),
        });
        return Promise.resolve(command(node)).then(() => {
            expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
        });
    });

    it('does nothing without a connection', () => {
        const command = commandFor('clickhouse.showCreateTable', undefined);
        return Promise.resolve(command(node)).then(() => {
            expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
        });
    });
});
