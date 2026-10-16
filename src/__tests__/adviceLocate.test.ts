/**
 * Tests for putting a finding back where it came from.
 *
 * Measurements carry no source positions — `processors_profile_log` has never
 * heard of the text. But a finding knows what it is about, and the parse tree
 * knows where that is, so the two can be joined.
 */
import { locate } from '../advice/locate';
import { parse } from '../parser/parser';
import { Finding } from '../advice/types';

function rangeIn(sql: string, finding: Finding): string | undefined {
    const found = locate(finding, parse(sql).program);
    return found ? sql.slice(found.start, found.end) : undefined;
}

const about = (kind: 'function' | 'table' | 'column', name: string): Finding => ({
    ruleId: 'r',
    importance: 'medium',
    title: 't',
    evidence: 'e',
    subject: { kind, name },
});

describe('locate', () => {
    it('finds the function a finding is about', () => {
        expect(rangeIn('SELECT uniqExact(user_id) FROM events', about('function', 'uniqExact'))).toBe(
            'uniqExact'
        );
    });

    it('does not care how the function was cased', () => {
        expect(rangeIn('SELECT UNIQEXACT(x) FROM t', about('function', 'uniqExact'))).toBe('UNIQEXACT');
    });

    it('finds a table named with its database', () => {
        expect(rangeIn('SELECT a FROM demo.orders', about('table', 'demo.orders'))).toBe('demo.orders');
    });

    it('finds a table the query named without its database', () => {
        expect(rangeIn('SELECT a FROM orders', about('table', 'demo.orders'))).toBe('orders');
    });

    it('finds the right table when the query reads several', () => {
        const sql = 'SELECT a FROM demo.events AS e INNER JOIN demo.orders AS o ON o.id = e.id';
        expect(rangeIn(sql, about('table', 'demo.orders'))).toBe('demo.orders');
    });

    it('finds a column', () => {
        expect(rangeIn('SELECT a FROM t WHERE status = 1', about('column', 'status'))).toBe('status');
    });

    it('says nothing rather than guessing when the subject is not there', () => {
        expect(rangeIn('SELECT a FROM t', about('function', 'uniqExact'))).toBeUndefined();
        expect(rangeIn('SELECT a FROM t', about('table', 'demo.orders'))).toBeUndefined();
    });

    it('says nothing for a finding that is about the query as a whole', () => {
        const whole: Finding = { ruleId: 'r', importance: 'low', title: 't', evidence: 'e' };
        expect(locate(whole, parse('SELECT 1').program)).toBeUndefined();
    });

    it('ignores a name that only appears inside a string', () => {
        expect(rangeIn("SELECT 'uniqExact' AS s FROM t", about('function', 'uniqExact'))).toBeUndefined();
    });
});
