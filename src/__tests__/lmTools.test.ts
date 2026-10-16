/**
 * Tests for the language model tool surface.
 *
 * The property that matters is that an agent cannot write, whatever the
 * connection profile would otherwise allow.
 */
import { guardAgentQuery, formatResultForModel } from '../lm/tools';
import { QueryResult } from '../client/types';

describe('guardAgentQuery', () => {
    it('allows a query', () => {
        expect(guardAgentQuery('SELECT count() FROM events').ok).toBe(true);
        expect(guardAgentQuery('WITH c AS (SELECT 1) SELECT * FROM c').ok).toBe(true);
    });

    it('allows introspection', () => {
        expect(guardAgentQuery('SHOW TABLES').ok).toBe(true);
        expect(guardAgentQuery('DESCRIBE TABLE events').ok).toBe(true);
        expect(guardAgentQuery('EXPLAIN SELECT 1').ok).toBe(true);
    });

    it('refuses a write', () => {
        const verdict = guardAgentQuery('INSERT INTO events VALUES (1)');
        expect(verdict.ok).toBe(false);
        expect(verdict.ok === false && verdict.reason).toContain('read-only');
    });

    it('refuses a destructive statement', () => {
        expect(guardAgentQuery('DROP TABLE events').ok).toBe(false);
        expect(guardAgentQuery('TRUNCATE TABLE events').ok).toBe(false);
    });

    it('refuses a lightweight DELETE and UPDATE', () => {
        expect(guardAgentQuery('DELETE FROM events WHERE id = 1').ok).toBe(false);
        expect(guardAgentQuery('UPDATE events SET a = 1 WHERE id = 1').ok).toBe(false);
    });

    it('refuses a statement it cannot place', () => {
        expect(guardAgentQuery('REWIND TABLE events TO 5').ok).toBe(false);
    });

    it('refuses a batch where any one statement writes', () => {
        expect(guardAgentQuery('SELECT 1; INSERT INTO t VALUES (1)').ok).toBe(false);
    });

    it('refuses an empty query rather than sending it', () => {
        expect(guardAgentQuery('   ').ok).toBe(false);
        expect(guardAgentQuery('-- just a comment').ok).toBe(false);
    });

    it('names the statement it refused', () => {
        const verdict = guardAgentQuery('DROP TABLE analytics.events');
        expect(verdict.ok === false && verdict.reason).toContain('DROP TABLE analytics.events');
    });
});

describe('formatResultForModel', () => {
    const result = (over: Partial<QueryResult> = {}): QueryResult => ({
        queryId: 'q1',
        columns: [
            { name: 'name', type: 'String' },
            { name: 'rows', type: 'UInt64' },
        ],
        rows: [
            ['events', '1200'],
            ['users', '42'],
        ],
        truncated: false,
        elapsedMs: 12,
        ...over,
    });

    it('renders the columns with their types and the rows', () => {
        const text = formatResultForModel(result());
        expect(text).toContain('name String');
        expect(text).toContain('rows UInt64');
        expect(text).toContain('events\t1200');
    });

    it('says how many rows came back', () => {
        expect(formatResultForModel(result())).toContain('2 rows');
    });

    it('says when the read stopped early', () => {
        expect(formatResultForModel(result({ truncated: true }))).toContain('truncated');
    });

    it('says plainly when nothing came back', () => {
        expect(formatResultForModel(result({ rows: [] }))).toContain('no rows');
    });

    it('renders a null as something a model will not read as a string', () => {
        const text = formatResultForModel(result({ rows: [[null, '1']] }));
        expect(text).toContain('NULL');
    });
});
