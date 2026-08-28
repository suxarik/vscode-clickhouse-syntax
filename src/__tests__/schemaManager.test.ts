/**
 * Tests for schema loading, validation and lookup.
 */
import { validateSchema } from '../schemaManager';
import { makeSchemaManager, SAMPLE_SCHEMA } from './helpers';

describe('validateSchema', () => {
    it('accepts a well-formed schema', () => {
        expect(validateSchema(SAMPLE_SCHEMA)).toEqual([]);
    });

    it('rejects a non-object', () => {
        expect(validateSchema(null)).toHaveLength(1);
        expect(validateSchema('nope')).toHaveLength(1);
    });

    it('requires a databases array', () => {
        expect(validateSchema({})[0].path).toBe('databases');
    });

    it('reports the path of a bad table', () => {
        const issues = validateSchema({ databases: [{ name: 'db', tables: [{ columns: [] }] }] });
        expect(issues[0].path).toBe('databases[0].tables[0].name');
    });

    it('reports a column missing its type', () => {
        const issues = validateSchema({
            databases: [{ name: 'db', tables: [{ name: 't', columns: [{ name: 'c' }] }] }],
        });
        expect(issues[0].path).toBe('databases[0].tables[0].columns[0].type');
    });

    it('collects several issues at once', () => {
        const issues = validateSchema({
            databases: [{ tables: [{ name: 't', columns: [{}] }] }],
        });
        expect(issues.length).toBeGreaterThan(1);
    });
});

describe('SchemaManager lookups', () => {
    it('finds a table by bare name', async () => {
        const manager = await makeSchemaManager();
        expect(manager.findTable('events')?.db).toBe('analytics');
    });

    it('finds a table by qualified name', async () => {
        const manager = await makeSchemaManager();
        expect(manager.findTable('events', 'analytics')?.table.name).toBe('events');
        expect(manager.findTable('events', 'nope')).toBeUndefined();
    });

    it('is case-insensitive', async () => {
        const manager = await makeSchemaManager();
        expect(manager.findTable('EVENTS')).toBeDefined();
        expect(manager.findColumn('events', 'EVENT_ID')).toBeDefined();
    });

    it('reports the engine', async () => {
        const manager = await makeSchemaManager();
        expect(manager.getEngine('users')).toBe('ReplacingMergeTree');
        expect(manager.getEngine('nope')).toBeUndefined();
    });

    it('finds every table a column appears in', async () => {
        const manager = await makeSchemaManager();
        expect(manager.findColumnsByName('user_id').map(m => m.table).sort()).toEqual(['events', 'users']);
    });

    it('lists databases and tables', async () => {
        const manager = await makeSchemaManager();
        expect(manager.getDatabases()).toEqual(['analytics']);
        expect(manager.getTables().map(t => t.table.name)).toEqual(['events', 'users']);
        expect(manager.getTables('analytics')).toHaveLength(2);
        expect(manager.getTables('other')).toHaveLength(0);
    });

    it('reports no schema when no file matches', async () => {
        const manager = await makeSchemaManager(null);
        expect(manager.getSchema()).toBeNull();
        expect(manager.findTable('events')).toBeUndefined();
        expect(manager.getAllColumns()).toEqual([]);
    });
});
