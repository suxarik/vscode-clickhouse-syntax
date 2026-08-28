/**
 * Tests for statement classification and the safety gate.
 */
import { parse } from '../parser/parser';
import { classifyStatement, combinedEffect, gate, StatementSummary } from '../client/safety';

/** Classify every statement in a script. */
function classify(sql: string): StatementSummary[] {
    return parse(sql).program.statements.map(classifyStatement);
}

function effect(sql: string) {
    return classify(sql)[0]?.effect;
}

describe('classifyStatement', () => {
    it('treats queries as reads', () => {
        expect(effect('SELECT 1')).toBe('read');
        expect(effect('WITH c AS (SELECT 1) SELECT * FROM c')).toBe('read');
        expect(effect('SELECT * FROM system.parts')).toBe('read');
    });

    it('treats introspection as a read', () => {
        expect(effect('SHOW TABLES')).toBe('read');
        expect(effect('DESCRIBE TABLE t')).toBe('read');
        expect(effect('EXPLAIN SELECT 1')).toBe('read');
        expect(effect('EXISTS TABLE t')).toBe('read');
    });

    it('treats INSERT and CREATE as writes', () => {
        expect(effect('INSERT INTO t VALUES (1)')).toBe('write');
        expect(effect('CREATE TABLE t (a UInt8) ENGINE = Memory')).toBe('write');
        expect(effect('CREATE MATERIALIZED VIEW mv AS SELECT 1')).toBe('write');
    });

    it('treats DROP and TRUNCATE as destructive', () => {
        expect(effect('DROP TABLE t')).toBe('destructive');
        expect(effect('TRUNCATE TABLE t')).toBe('destructive');
        expect(effect('DETACH TABLE t')).toBe('destructive');
    });

    it('treats SYSTEM and KILL as destructive', () => {
        expect(effect('SYSTEM DROP QUERY CACHE')).toBe('destructive');
        expect(effect('KILL QUERY WHERE 1')).toBe('destructive');
    });

    it('separates metadata ALTERs from data ALTERs', () => {
        expect(effect('ALTER TABLE t ADD COLUMN c UInt8')).toBe('write');
        expect(effect('ALTER TABLE t MODIFY COLUMN c UInt16')).toBe('write');
        expect(effect('ALTER TABLE t DELETE WHERE id = 1')).toBe('destructive');
        expect(effect('ALTER TABLE t DROP COLUMN c')).toBe('destructive');
        expect(effect('ALTER TABLE t DROP PARTITION 202401')).toBe('destructive');
    });

    it('labels the target for a prompt', () => {
        expect(classify('DROP TABLE analytics.events')[0]).toMatchObject({
            label: 'DROP TABLE analytics.events',
            target: 'analytics.events',
        });
        expect(classify('INSERT INTO t VALUES (1)')[0].label).toBe('INSERT INTO t');
    });

    it('classifies every statement in a script', () => {
        expect(classify('SELECT 1; DROP TABLE t; INSERT INTO u VALUES (1)').map(s => s.effect)).toEqual([
            'read',
            'destructive',
            'write',
        ]);
    });

    it('does not mistake a string for a statement', () => {
        expect(effect("SELECT 'DROP TABLE t'")).toBe('read');
    });

    it('does not mistake a comment for a statement', () => {
        expect(effect('-- DROP TABLE t\nSELECT 1')).toBe('read');
    });
});

describe('combinedEffect', () => {
    it('takes the strongest effect in the batch', () => {
        expect(combinedEffect(classify('SELECT 1; SELECT 2'))).toBe('read');
        expect(combinedEffect(classify('SELECT 1; INSERT INTO t VALUES (1)'))).toBe('write');
        expect(combinedEffect(classify('INSERT INTO t VALUES (1); DROP TABLE u'))).toBe('destructive');
    });

    it('is a read for an empty batch', () => {
        expect(combinedEffect([])).toBe('read');
    });
});

describe('gate', () => {
    const forSql = (sql: string, options: { allowWrite?: boolean; isProtected?: boolean } = {}) =>
        gate({
            summaries: classify(sql),
            allowWrite: options.allowWrite ?? false,
            isProtected: options.isProtected ?? false,
            profileName: 'prod',
        });

    it('runs a read without asking', () => {
        expect(forSql('SELECT 1')).toEqual({ action: 'run' });
        expect(forSql('SELECT 1', { allowWrite: true, isProtected: true })).toEqual({ action: 'run' });
    });

    it('refuses a write on a read-only profile rather than prompting', () => {
        const decision = forSql('INSERT INTO t VALUES (1)');
        expect(decision.action).toBe('refuse');
        expect(decision.action === 'refuse' && decision.message).toContain('read-only');
        expect(decision.action === 'refuse' && decision.message).toContain('allowWrite');
    });

    it('refuses a destructive statement on a read-only profile', () => {
        expect(forSql('DROP TABLE t').action).toBe('refuse');
    });

    it('confirms a write on a writable profile', () => {
        const decision = forSql('INSERT INTO t VALUES (1)', { allowWrite: true });
        expect(decision.action).toBe('confirm');
        expect(decision.action === 'confirm' && decision.message).toContain('prod');
    });

    it('warns that a destructive statement cannot be undone', () => {
        const decision = forSql('DROP TABLE t', { allowWrite: true });
        expect(decision.action === 'confirm' && decision.message).toContain('cannot be undone');
    });

    it('requires the profile name typed on a protected profile', () => {
        const decision = forSql('DROP TABLE t', { allowWrite: true, isProtected: true });
        expect(decision.action).toBe('confirmTyped');
        expect(decision.action === 'confirmTyped' && decision.expected).toBe('prod');
    });

    it('protects writes, not just destructive statements', () => {
        expect(forSql('INSERT INTO t VALUES (1)', { allowWrite: true, isProtected: true }).action).toBe(
            'confirmTyped'
        );
    });

    it('names the batch when several statements need permission', () => {
        const decision = forSql('DROP TABLE a; DROP TABLE b', { allowWrite: true });
        expect(decision.action === 'confirm' && decision.message).toContain('2 statements');
    });

    it('ignores reads when describing the batch', () => {
        const decision = forSql('SELECT 1; DROP TABLE a', { allowWrite: true });
        expect(decision.action === 'confirm' && decision.message).toContain('DROP TABLE a');
        expect(decision.action === 'confirm' && decision.message).not.toContain('2 statements');
    });
});
