/**
 * Tests for finding and watching the dbt manifest.
 *
 * dbt rewrites `target/manifest.json` on every compile, so the behaviour that
 * matters is what happens around that write: a half-written file must not
 * replace a good one, and a new model must turn up without a reload.
 */
import * as vscode from 'vscode';
import { DbtProject } from '../dbt/project';

const MANIFEST = {
    nodes: { 'model.shop.users': { resource_type: 'model', name: 'users', schema: 'analytics' } },
    sources: {},
};

/** Make `findFiles` and `readFile` answer with a manifest, or with nothing. */
function stubWorkspace(content: unknown | undefined, options: { trusted?: boolean; folders?: boolean } = {}) {
    (vscode.workspace as unknown as { isTrusted: boolean }).isTrusted = options.trusted ?? true;
    (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders =
        options.folders === false ? undefined : [{ uri: vscode.Uri.file('/w') }];

    const uri = vscode.Uri.file('/w/target/manifest.json');
    (vscode.workspace.findFiles as jest.Mock).mockResolvedValue(content === undefined ? [] : [uri]);
    (vscode.workspace.fs.readFile as jest.Mock).mockResolvedValue(
        new TextEncoder().encode(typeof content === 'string' ? content : JSON.stringify(content ?? {}))
    );

    const handlers: Record<string, (uri: vscode.Uri) => void> = {};
    (vscode.workspace.createFileSystemWatcher as jest.Mock).mockReturnValue({
        onDidCreate: (handler: (uri: vscode.Uri) => void) => void (handlers.create = handler),
        onDidChange: (handler: (uri: vscode.Uri) => void) => void (handlers.change = handler),
        onDidDelete: (handler: (uri: vscode.Uri) => void) => void (handlers.delete = handler),
        dispose: jest.fn(),
    });
    return { uri, handlers };
}

beforeEach(() => {
    jest.clearAllMocks();
    (vscode as unknown as { __resetConfig(): void }).__resetConfig();
});

describe('loading the manifest', () => {
    it('reads what dbt compiled', async () => {
        stubWorkspace(MANIFEST);
        const project = new DbtProject();
        await project.load();
        expect(project.loaded).toBe(true);
        expect(project.resolve('ref', ['users'])).toEqual({ table: 'users', database: 'analytics' });
        project.dispose();
    });

    it('does nothing in an untrusted workspace', async () => {
        // Workspace settings decide what gets read, so an untrusted folder gets
        // nothing - the same rule connections follow.
        stubWorkspace(MANIFEST, { trusted: false });
        const project = new DbtProject();
        await project.load();
        expect(project.loaded).toBe(false);
        expect(vscode.workspace.findFiles).not.toHaveBeenCalled();
        project.dispose();
    });

    it('does nothing without a workspace at all', async () => {
        stubWorkspace(MANIFEST, { folders: false });
        const project = new DbtProject();
        await project.load();
        expect(project.loaded).toBe(false);
        project.dispose();
    });

    it('is simply absent when there is no dbt project', async () => {
        stubWorkspace(undefined);
        const project = new DbtProject();
        await project.load();
        expect(project.loaded).toBe(false);
        expect(project.resolve('ref', ['users'])).toBeUndefined();
        expect(project.modelNames()).toEqual([]);
        project.dispose();
    });

    it('survives an unreadable file', async () => {
        stubWorkspace(MANIFEST);
        (vscode.workspace.fs.readFile as jest.Mock).mockRejectedValue(new Error('EACCES'));
        const project = new DbtProject();
        await expect(project.load()).resolves.toBeUndefined();
        expect(project.loaded).toBe(false);
        project.dispose();
    });
});

describe('watching the manifest', () => {
    it('picks up a model added since activation', async () => {
        const { uri, handlers } = stubWorkspace(undefined);
        const project = new DbtProject();
        const changes: number[] = [];
        project.onDidChange(() => changes.push(project.size));
        await project.load();
        expect(project.loaded).toBe(false);

        (vscode.workspace.fs.readFile as jest.Mock).mockResolvedValue(
            new TextEncoder().encode(JSON.stringify(MANIFEST))
        );
        await handlers.create(uri);

        expect(project.resolve('ref', ['users'])).toBeDefined();
        expect(changes).toEqual([1]);
        project.dispose();
    });

    it('keeps the good manifest when dbt is caught mid-write', async () => {
        const { uri, handlers } = stubWorkspace(MANIFEST);
        const project = new DbtProject();
        await project.load();

        (vscode.workspace.fs.readFile as jest.Mock).mockResolvedValue(
            new TextEncoder().encode('{"nodes": {')
        );
        await handlers.change(uri);

        // Still answering from the last complete read.
        expect(project.resolve('ref', ['users'])).toBeDefined();
        project.dispose();
    });

    it('forgets everything when the manifest is deleted', async () => {
        const { handlers } = stubWorkspace(MANIFEST);
        const project = new DbtProject();
        await project.load();
        handlers.delete(vscode.Uri.file('/w/target/manifest.json'));
        expect(project.loaded).toBe(false);
        expect(project.resolve('ref', ['users'])).toBeUndefined();
        project.dispose();
    });

    it('watches once, however often it is loaded', async () => {
        stubWorkspace(MANIFEST);
        const project = new DbtProject();
        await project.load();
        await project.load();
        expect(vscode.workspace.createFileSystemWatcher).toHaveBeenCalledTimes(1);
        project.dispose();
    });
});
