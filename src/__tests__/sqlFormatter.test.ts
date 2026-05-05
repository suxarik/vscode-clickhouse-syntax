/**
 * Tests for SQL formatter.
 */
import { formatSQL } from '../sqlFormatter';

describe('formatSQL', () => {
    it('formats basic SELECT', () => {
        const input = "select a,b,c from t where x=1";
        const output = formatSQL(input, 'upper', 4);
        expect(output).toContain('SELECT');
        expect(output).toMatch(/FROM\s+t/);
        expect(output).toContain('WHERE');
    });

    it('preserves case when requested', () => {
        const input = "select a from t";
        const output = formatSQL(input, 'preserve', 4);
        expect(output).toContain('select');
        expect(output).toContain('from');
    });

    it('lowercases keywords when requested', () => {
        const input = "SELECT a FROM t";
        const output = formatSQL(input, 'lower', 4);
        expect(output).toContain('select');
        expect(output).toContain('from');
    });

    it('handles empty string', () => {
        expect(formatSQL('', 'upper', 4)).toBe('');
    });

    it('preserves string literals', () => {
        const input = "SELECT name FROM t WHERE name = 'hello world'";
        const output = formatSQL(input, 'upper', 4);
        expect(output).toContain("'hello world'");
    });

    it('breaks before FROM clause', () => {
        const input = "SELECT a,b FROM t";
        const output = formatSQL(input, 'upper', 4);
        const lines = output.split('\n');
        expect(lines.some(l => l.includes('SELECT'))).toBe(true);
        expect(lines.some(l => l.includes('FROM'))).toBe(true);
    });

    it('handles JOIN keywords', () => {
        const input = "SELECT * FROM a INNER JOIN b ON a.id = b.id";
        const output = formatSQL(input, 'upper', 4);
        expect(output).toContain('INNER JOIN');
    });

    it('handles comments', () => {
        const input = "SELECT a FROM t /* comment */ WHERE x = 1";
        const output = formatSQL(input, 'upper', 4);
        expect(output).toContain('/* comment */');
    });
});
