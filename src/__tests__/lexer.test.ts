/**
 * Tests for the ClickHouse SQL tokenizer.
 */
import { tokenize, TokenKind, isTrivia, tokenAtOffset } from '../lexer';

const kinds = (sql: string) => tokenize(sql).filter(t => !isTrivia(t)).map(t => t.kind);
const texts = (sql: string) => tokenize(sql).filter(t => !isTrivia(t)).map(t => t.text);

describe('tokenize', () => {
    it('splits a simple statement', () => {
        expect(texts('SELECT a FROM t')).toEqual(['SELECT', 'a', 'FROM', 't']);
    });

    it('keeps single-quoted strings whole', () => {
        expect(texts("SELECT 'a, b FROM c'")).toEqual(['SELECT', "'a, b FROM c'"]);
    });

    it('handles backslash escapes in strings', () => {
        expect(texts("SELECT 'it\\'s'")).toEqual(['SELECT', "'it\\'s'"]);
    });

    it('handles doubled-quote escapes in strings', () => {
        expect(texts("SELECT 'it''s'")).toEqual(['SELECT', "'it''s'"]);
    });

    it('handles backtick identifiers', () => {
        expect(texts('SELECT `weird name` FROM t')).toEqual(['SELECT', '`weird name`', 'FROM', 't']);
    });

    it('handles double-quoted identifiers', () => {
        expect(kinds('SELECT "col" FROM t')[1]).toBe(TokenKind.QuotedIdent);
    });

    it('handles heredoc strings', () => {
        expect(texts('SELECT $doc$anything $ here$doc$')).toEqual(['SELECT', '$doc$anything $ here$doc$']);
    });

    it('recognises line comments', () => {
        const tokens = tokenize('-- hello\nSELECT 1');
        expect(tokens[0].kind).toBe(TokenKind.LineComment);
        expect(tokens[0].text).toBe('-- hello');
    });

    it('recognises hash comments', () => {
        expect(tokenize('# hello\nSELECT 1')[0].kind).toBe(TokenKind.LineComment);
    });

    it('recognises block comments', () => {
        const tokens = tokenize('/* a\nb */ SELECT 1');
        expect(tokens[0].kind).toBe(TokenKind.BlockComment);
        expect(tokens[0].text).toBe('/* a\nb */');
    });

    it('does not treat -- inside a string as a comment', () => {
        expect(texts("SELECT '-- not a comment'")).toEqual(['SELECT', "'-- not a comment'"]);
    });

    it('reads numbers in all supported forms', () => {
        expect(texts('SELECT 1, 1.5, .5, 1e10, 1.2e-3, 0xFF, 0b1010')).toEqual([
            'SELECT', '1', ',', '1.5', ',', '.5', ',', '1e10', ',', '1.2e-3', ',', '0xFF', ',', '0b1010',
        ]);
    });

    it('reads multi-character operators', () => {
        expect(texts('a -> b :: c >= d != e || f')).toEqual(['a', '->', 'b', '::', 'c', '>=', 'd', '!=', 'e', '||', 'f']);
    });

    it('survives an unterminated string', () => {
        const tokens = tokenize("SELECT 'oops");
        expect(tokens[tokens.length - 1].kind).toBe(TokenKind.String);
    });

    it('survives an unterminated block comment', () => {
        const tokens = tokenize('SELECT /* oops');
        expect(tokens[tokens.length - 1].kind).toBe(TokenKind.BlockComment);
    });

    it('covers the whole input with no gaps', () => {
        const sql = "SELECT a, 'x' /* c */ FROM `t` -- tail\nWHERE b = 1";
        const tokens = tokenize(sql);
        expect(tokens.map(t => t.text).join('')).toBe(sql);
        for (let i = 1; i < tokens.length; i++) {
            expect(tokens[i].start).toBe(tokens[i - 1].end);
        }
    });

    it('uppercases word tokens for lookups', () => {
        expect(tokenize('select')[0].upper).toBe('SELECT');
    });
});

describe('tokenAtOffset', () => {
    it('finds the token containing an offset', () => {
        const sql = 'SELECT abc FROM t';
        const tokens = tokenize(sql);
        expect(tokens[tokenAtOffset(tokens, 8)].text).toBe('abc');
    });

    it('returns -1 past the end', () => {
        const tokens = tokenize('SELECT 1');
        expect(tokenAtOffset(tokens, 999)).toBe(-1);
    });
});
