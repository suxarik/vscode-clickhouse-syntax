/**
 * Tests for keyword classification.
 */
import { tokenize, TokenKind } from '../lexer';
import { findKeywordTokens, applyKeywordCase, statementKind } from '../keywords';

/** Words classified as keywords, in order. */
function keywordWords(sql: string): string[] {
    const tokens = tokenize(sql);
    const keywords = findKeywordTokens(tokens);
    return [...keywords].sort((a, b) => a - b).map(i => tokens[i].upper);
}

function isKeyword(sql: string, word: string): boolean {
    return keywordWords(sql).includes(word.toUpperCase());
}

describe('findKeywordTokens', () => {
    it('recognises plain clause keywords', () => {
        expect(keywordWords('SELECT a FROM t WHERE b = 1')).toEqual(['SELECT', 'FROM', 'WHERE']);
    });

    it('does not classify identifiers that collide with keywords', () => {
        const sql = 'SELECT first, last, range, row, set FROM t';
        for (const word of ['FIRST', 'LAST', 'RANGE', 'ROW', 'SET']) {
            expect(isKeyword(sql, word)).toBe(false);
        }
    });

    it('does not classify system-table column names', () => {
        const sql = 'SELECT database, table, engine, partition, comment, type FROM system.parts';
        for (const word of ['DATABASE', 'TABLE', 'ENGINE', 'PARTITION', 'COMMENT', 'TYPE']) {
            expect(isKeyword(sql, word)).toBe(false);
        }
    });

    it('classifies the same words inside DDL', () => {
        const sql = "CREATE TABLE t (a UInt8 DEFAULT 1 COMMENT 'x') ENGINE = MergeTree PARTITION BY a";
        for (const word of ['CREATE', 'TABLE', 'DEFAULT', 'COMMENT', 'ENGINE', 'PARTITION', 'BY']) {
            expect(isKeyword(sql, word)).toBe(true);
        }
    });

    it('treats a qualifier as an identifier', () => {
        expect(isKeyword('SELECT * FROM system.parts', 'SYSTEM')).toBe(false);
        expect(isKeyword('SYSTEM RELOAD DICTIONARIES', 'SYSTEM')).toBe(true);
    });

    it('treats a qualified part as an identifier', () => {
        expect(isKeyword('SELECT t.range FROM t', 'RANGE')).toBe(false);
    });

    it('does not classify function calls that share a keyword name', () => {
        const sql = 'SELECT left(s, 2), right(s, 2), any(x), if(a, b, c), range(5)';
        for (const word of ['LEFT', 'RIGHT', 'ANY', 'IF', 'RANGE']) {
            expect(isKeyword(sql, word)).toBe(false);
        }
    });

    it('still classifies keywords legitimately followed by a paren', () => {
        expect(isKeyword('SELECT (a + b) FROM t', 'SELECT')).toBe(true);
        expect(isKeyword('SELECT * FROM (SELECT 1)', 'FROM')).toBe(true);
        expect(isKeyword('WHERE x IN (1, 2)', 'IN')).toBe(true);
        expect(isKeyword('WITH x AS (SELECT 1) SELECT * FROM x', 'AS')).toBe(true);
    });

    it('classifies join runs whole', () => {
        expect(keywordWords('a LEFT ANY JOIN b')).toEqual(['LEFT', 'ANY', 'JOIN']);
        expect(keywordWords('a GLOBAL LEFT ARRAY JOIN b')).toContain('ARRAY');
    });

    it('classifies END only when it closes a CASE', () => {
        expect(isKeyword("SELECT CASE WHEN a THEN 1 END FROM t", 'END')).toBe(true);
        expect(isKeyword('SELECT end FROM t', 'END')).toBe(false);
    });

    it('classifies FORMAT only before a format name', () => {
        expect(isKeyword('SELECT 1 FORMAT JSONEachRow', 'FORMAT')).toBe(true);
        expect(isKeyword('SELECT format FROM t', 'FORMAT')).toBe(false);
    });

    it('classifies SET after UPDATE and at statement start', () => {
        expect(isKeyword('ALTER TABLE t UPDATE x = 1 WHERE y = 2', 'UPDATE')).toBe(true);
        expect(isKeyword('SET max_threads = 4', 'SET')).toBe(true);
        expect(isKeyword('SELECT set FROM t', 'SET')).toBe(false);
    });

    it('classifies interval units only after an interval literal', () => {
        expect(isKeyword('SELECT now() - INTERVAL 3 DAY', 'DAY')).toBe(true);
        expect(isKeyword('SELECT day FROM t', 'DAY')).toBe(false);
    });

    it('classifies window frame bounds', () => {
        const sql = 'SELECT sum(x) OVER (ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) FROM t';
        for (const word of ['ROWS', 'BETWEEN', 'UNBOUNDED', 'PRECEDING', 'CURRENT', 'ROW']) {
            expect(isKeyword(sql, word)).toBe(true);
        }
    });

    it('ignores words inside comments and strings', () => {
        expect(keywordWords("-- SELECT FROM\nSELECT 'FROM WHERE' AS s")).toEqual(['SELECT', 'AS']);
    });
});

describe('applyKeywordCase', () => {
    const render = (sql: string, mode: 'upper' | 'lower' | 'preserve') => {
        const tokens = tokenize(sql);
        applyKeywordCase(tokens, mode);
        return tokens.map(t => t.text).join('');
    };

    it('uppercases keywords only', () => {
        expect(render('select first from t', 'upper')).toBe('SELECT first FROM t');
    });

    it('lowercases keywords only', () => {
        expect(render('SELECT First FROM t', 'lower')).toBe('select First from t');
    });

    it('leaves everything alone when preserving', () => {
        expect(render('SeLeCt a FrOm t', 'preserve')).toBe('SeLeCt a FrOm t');
    });
});

describe('statementKind', () => {
    it('classifies statements by their leading word', () => {
        expect(statementKind('SELECT')).toBe('select');
        expect(statementKind('WITH')).toBe('select');
        expect(statementKind('INSERT')).toBe('insert');
        expect(statementKind('CREATE')).toBe('ddl');
        expect(statementKind('ALTER')).toBe('ddl');
        expect(statementKind('SYSTEM')).toBe('system');
        expect(statementKind('BOGUS')).toBe('other');
    });
});

describe('token kinds used by classification', () => {
    it('marks word tokens', () => {
        expect(tokenize('SELECT')[0].kind).toBe(TokenKind.Word);
    });
});
