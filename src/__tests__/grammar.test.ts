/**
 * Structural tests for the TextMate grammars.
 *
 * The function, data-type and engine lists are regenerated from the catalog, so
 * these guard the shape of what the generator writes rather than its contents.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { makeCatalog } from './helpers';

const ROOT = path.resolve(__dirname, '..', '..');

interface Pattern {
    name?: string;
    match?: string;
    begin?: string;
    end?: string;
    patterns?: Pattern[];
    captures?: Record<string, unknown>;
    include?: string;
}

interface Grammar {
    scopeName: string;
    patterns: Pattern[];
    repository: Record<string, { patterns: Pattern[] }>;
}

function load(file: string): Grammar {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'syntaxes', file), 'utf8'));
}

const grammar = load('clickhouse.tmLanguage.json');
const injection = load('clickhouse-injection.tmLanguage.json');

/** Every regex in a grammar, wherever it appears. */
function collectRegexes(patterns: Pattern[], out: string[] = []): string[] {
    for (const pattern of patterns) {
        for (const key of ['match', 'begin', 'end'] as const) {
            if (typeof pattern[key] === 'string') out.push(pattern[key] as string);
        }
        if (pattern.patterns) collectRegexes(pattern.patterns, out);
    }
    return out;
}

function allRegexes(g: Grammar): string[] {
    const out = collectRegexes(g.patterns);
    for (const entry of Object.values(g.repository ?? {})) collectRegexes(entry.patterns ?? [], out);
    return out;
}

describe('grammar structure', () => {
    it('declares the expected scope names', () => {
        expect(grammar.scopeName).toBe('source.sql.clickhouse');
        expect(injection.scopeName).toBe('source.sql.clickhouse.injection');
    });

    it('resolves every include to a repository entry', () => {
        for (const pattern of grammar.patterns) {
            if (!pattern.include?.startsWith('#')) continue;
            expect(Object.keys(grammar.repository)).toContain(pattern.include.slice(1));
        }
    });

    it('compiles every regex', () => {
        for (const source of [...allRegexes(grammar), ...allRegexes(injection)]) {
            // `(?i)` is an Oniguruma inline flag; JS takes it as a flag instead.
            const inlineCaseInsensitive = source.startsWith('(?i)');
            const body = inlineCaseInsensitive ? source.slice(4) : source;
            expect(() => new RegExp(body, inlineCaseInsensitive ? 'i' : '')).not.toThrow();
        }
    });

    it('gives every leaf pattern a scope', () => {
        for (const [key, entry] of Object.entries(grammar.repository)) {
            for (const pattern of entry.patterns) {
                if (pattern.include) continue;
                // A pattern scopes itself, or scopes its capture groups.
                const scoped = (pattern.name ?? '').includes('.') || pattern.captures !== undefined;
                expect(`${key}: ${scoped ? 'scoped' : 'unscoped'}`).toContain('scoped');
            }
        }
    });

    it('keeps ClickHouse-specific scopes distinguishable from generic SQL ones', () => {
        for (const key of Object.keys(grammar.repository)) {
            if (!key.startsWith('ch-')) continue;
            for (const pattern of grammar.repository[key].patterns) {
                expect(`${key}: ${pattern.name}`).toContain('.clickhouse');
            }
        }
    });
});

describe('generated function lists', () => {
    const catalog = makeCatalog();

    it('covers every catalog function across the group repositories', () => {
        const listed = new Set<string>();
        for (const [key, entry] of Object.entries(grammar.repository)) {
            if (!key.endsWith('-functions')) continue;
            for (const pattern of entry.patterns) {
                const inner = pattern.match?.match(/\(([^)]*)\)\(\?=/);
                if (!inner) continue;
                for (const name of inner[1].split('|')) listed.add(name);
            }
        }
        for (const fn of catalog.functions()) {
            expect(listed.has(fn.name)).toBe(true);
        }
    });

    it('orders alternations longest-first so prefixes cannot shadow', () => {
        for (const [key, entry] of Object.entries(grammar.repository)) {
            if (!key.endsWith('-functions')) continue;
            for (const pattern of entry.patterns) {
                const inner = pattern.match?.match(/\(([^)]*)\)\(\?=/);
                if (!inner) continue;
                const names = inner[1].split('|');
                for (let i = 1; i < names.length; i++) {
                    expect(names[i - 1].length).toBeGreaterThanOrEqual(names[i].length);
                }
            }
        }
    });

    it('matches only function calls, not bare identifiers', () => {
        for (const [key, entry] of Object.entries(grammar.repository)) {
            if (!key.endsWith('-functions')) continue;
            for (const pattern of entry.patterns) {
                expect(pattern.match).toMatch(/\(\?=\\s\*\\\(\)$/);
            }
        }
    });

    it('lists every catalog data type and engine', () => {
        const types = grammar.repository['ch-data-types'].patterns.map(p => p.match ?? '').join('|');
        for (const type of catalog.dataTypes()) {
            expect(types).toContain(type.name);
        }
        const engines = grammar.repository['ch-engines'].patterns.map(p => p.match ?? '').join('|');
        for (const engine of catalog.engines()) {
            expect(engines).toContain(engine.name);
        }
    });
});
