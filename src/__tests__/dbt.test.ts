/**
 * Tests for dbt awareness.
 *
 * A dbt model is not ClickHouse SQL until dbt has compiled it, so the rule
 * throughout is: understand `ref` and `source` because the manifest says what
 * they mean, and leave everything else opaque rather than guessing.
 */
import { parse } from '../parser/parser';
import { bind, ColumnSource } from '../parser/binder';
import { tokenize, TokenKind, isTrivia, isTemplateBlock, isTemplateExpression } from '../lexer';
import { readTemplateCall, templateLabel } from '../parser/template';
import { DbtManifest, parseManifest, clickHouseName } from '../dbt/manifest';
import { dbtCompletionAt, dbtCompletionItems } from '../dbt/completion';

/** A manifest in the shape dbt actually writes. */
const MANIFEST = {
    nodes: {
        'model.shop.users': {
            resource_type: 'model',
            name: 'users',
            alias: 'users',
            database: 'default',
            schema: 'analytics',
        },
        'model.shop.orders': {
            resource_type: 'model',
            name: 'orders',
            alias: 'orders_v2',
            schema: 'analytics',
        },
        'seed.shop.countries': { resource_type: 'seed', name: 'countries', schema: 'seeds' },
        'test.shop.not_null_users_id': { resource_type: 'test', name: 'not_null_users_id' },
    },
    sources: {
        'source.shop.raw.events': {
            resource_type: 'source',
            source_name: 'raw',
            name: 'events',
            identifier: 'events_raw',
            schema: 'landing',
        },
        'source.shop.raw.clicks': { resource_type: 'source', source_name: 'raw', name: 'clicks', schema: 'landing' },
    },
};

const manifest = () => new DbtManifest(MANIFEST);

describe('lexing a Jinja tag', () => {
    const kinds = (sql: string) => tokenize(sql).filter(t => t.kind === TokenKind.Template).map(t => t.text);

    it('takes the whole tag as one token', () => {
        expect(kinds("SELECT * FROM {{ ref('users') }}")).toEqual(["{{ ref('users') }}"]);
        expect(kinds('{% if x %}SELECT 1{% endif %}')).toEqual(['{% if x %}', '{% endif %}']);
        expect(kinds('{# note #}SELECT 1')).toEqual(['{# note #}']);
    });

    it('handles dbt whitespace control', () => {
        expect(kinds('SELECT {{- 1 -}}')).toEqual(['{{- 1 -}}']);
    });

    it('runs an unterminated tag to the end rather than abandoning the file', () => {
        // Half a document is worse than one bad token.
        expect(kinds("SELECT * FROM {{ ref('x'")).toEqual(["{{ ref('x'"]);
    });

    it('does not mistake a placeholder or a map for a tag', () => {
        expect(kinds('SELECT {n:UInt64}')).toEqual([]);
        expect(kinds("SELECT {'a': 1}")).toEqual([]);
    });

    it('treats control flow and comments as trivia, but not a value tag', () => {
        // `{% if %}` wraps SQL; `{{ x }}` stands in place of some.
        const tokens = tokenize("{% if a %}SELECT {{ b }}{% endif %}{# c #}");
        const templates = tokens.filter(t => t.kind === TokenKind.Template);
        expect(templates.filter(isTemplateBlock).map(t => t.text)).toEqual([
            '{% if a %}',
            '{% endif %}',
            '{# c #}',
        ]);
        expect(templates.filter(isTemplateExpression).map(t => t.text)).toEqual(['{{ b }}']);
        expect(templates.filter(isTrivia).map(t => t.text)).toHaveLength(3);
    });
});

describe('reading a tag', () => {
    it('reads ref and source with dbt\'s own spacing', () => {
        expect(readTemplateCall("{{ ref('users') }}")).toEqual({ call: 'ref', arguments: ['users'] });
        expect(readTemplateCall('{{ref("users")}}')).toEqual({ call: 'ref', arguments: ['users'] });
        expect(readTemplateCall("{{- source('raw', 'events') -}}")).toEqual({
            call: 'source',
            arguments: ['raw', 'events'],
        });
    });

    it('refuses to guess at anything that is not plain strings', () => {
        // A macro can emit arbitrary SQL; a confident wrong answer is worse
        // than admitting we do not know.
        expect(readTemplateCall("{{ ref(var('model')) }}")).toBeUndefined();
        expect(readTemplateCall('{{ this }}')).toBeUndefined();
        expect(readTemplateCall("{{ dbt_utils.star(from=ref('a')) }}")).toBeUndefined();
        expect(readTemplateCall('{{ ref() }}')).toBeUndefined();
        expect(readTemplateCall('{% if x %}')).toBeUndefined();
    });

    it('labels a tag readably, and leaves an unreadable one as it is', () => {
        expect(templateLabel("{{ ref('users') }}")).toBe('users');
        expect(templateLabel("{{ source('raw', 'events') }}")).toBe('raw.events');
        expect(templateLabel('{{ this }}')).toBe('{{ this }}');
    });
});

describe('parsing a dbt model', () => {
    const errorsIn = (sql: string) => parse(sql).diagnostics;

    it('parses a model that opens with a config block', () => {
        const sql = "{{ config(materialized='table') }}\n\nSELECT id FROM {{ ref('users') }}";
        expect(errorsIn(sql)).toHaveLength(0);
        expect(parse(sql).program.statements).toHaveLength(1);
    });

    it('parses control flow wrapped around a WHERE clause', () => {
        const sql = [
            "SELECT * FROM {{ ref('events') }}",
            '{% if is_incremental() %}',
            'WHERE ts > (SELECT max(ts) FROM {{ this }})',
            '{% endif %}',
        ].join('\n');
        expect(errorsIn(sql)).toHaveLength(0);
    });

    it('parses a tag standing in for a select item', () => {
        expect(errorsIn("SELECT {{ var('col') }} AS c FROM {{ ref('t') }}")).toHaveLength(0);
    });

    it('keeps a tag in table position as a table, so everything downstream still works', () => {
        const program = parse("SELECT * FROM {{ ref('users') }} AS u").program;
        const binding = bind(program);
        const table = binding.scopes.flatMap(scope => scope.tables)[0];
        expect(table.kind).toBe('table');
        expect(table.label).toBe('u');
        expect(table.table).toBe('users');
    });

    it('survives an unterminated tag', () => {
        expect(() => parse("SELECT * FROM {{ ref('x'")).not.toThrow();
    });
});

describe('the manifest', () => {
    it('resolves a ref to the relation dbt will actually create', () => {
        expect(manifest().resolve('ref', ['users'])).toEqual({
            identifier: 'users',
            database: 'default',
            schema: 'analytics',
        });
    });

    it('uses the alias, which is the name that ends up in the warehouse', () => {
        expect(manifest().resolve('ref', ['orders'])?.identifier).toBe('orders_v2');
    });

    it('resolves a source by its two names', () => {
        expect(manifest().resolve('source', ['raw', 'events'])?.identifier).toBe('events_raw');
    });

    it('ignores the package argument, which does not change the relation', () => {
        expect(manifest().resolve('ref', ['shop', 'users'])?.identifier).toBe('users');
    });

    it('includes seeds, which are ref-able, and excludes tests, which are not', () => {
        expect(manifest().resolve('ref', ['countries'])).toBeDefined();
        expect(manifest().resolve('ref', ['not_null_users_id'])).toBeUndefined();
    });

    it('says nothing about a model it has never heard of', () => {
        expect(manifest().resolve('ref', ['nope'])).toBeUndefined();
        expect(manifest().resolve('source', ['raw', 'nope'])).toBeUndefined();
        expect(manifest().resolve('source', ['events'])).toBeUndefined();
    });

    it('maps dbt\'s schema onto what ClickHouse calls a database', () => {
        expect(clickHouseName({ identifier: 'users', database: 'default', schema: 'analytics' })).toEqual({
            table: 'users',
            database: 'analytics',
        });
        expect(clickHouseName({ identifier: 'x' })).toEqual({ table: 'x' });
    });

    it('survives a manifest caught half-written', () => {
        // dbt rewrites it on every compile, so this is a normal state, not a
        // corrupt one - and a broken language server would be a far worse outcome.
        expect(parseManifest(new TextEncoder().encode('{"nodes": {'))).toBeUndefined();
        expect(parseManifest(new TextEncoder().encode(''))).toBeUndefined();
        expect(parseManifest(new TextEncoder().encode('{}'))?.size).toBe(0);
    });

    it('lists what it knows, for completion', () => {
        expect(manifest().modelNames()).toEqual(['countries', 'orders', 'users']);
        expect(manifest().sourceNames()).toEqual(['raw.clicks', 'raw.events']);
    });
});

describe('binding a ref against the manifest', () => {
    const project = manifest();
    const columnSource: ColumnSource = {
        columnsOf: (table, database) =>
            table === 'users' && database === 'analytics' ? ['id', 'email'] : undefined,
        resolveTemplate: (call, args) => {
            const relation = project.resolve(call, args);
            return relation ? clickHouseName(relation) : undefined;
        },
    };

    it('gives a ref the columns of the table it resolves to', () => {
        const program = parse("SELECT * FROM {{ ref('users') }}").program;
        const table = bind(program, columnSource).scopes.flatMap(scope => scope.tables)[0];
        expect(table.columns).toEqual(['id', 'email']);
        expect(table.database).toBe('analytics');
    });

    it('leaves a ref it cannot resolve without columns rather than inventing some', () => {
        const program = parse("SELECT * FROM {{ ref('unknown_model') }}").program;
        const table = bind(program, columnSource).scopes.flatMap(scope => scope.tables)[0];
        expect(table.columns).toBeUndefined();
    });

    it('works without a manifest at all', () => {
        const program = parse("SELECT * FROM {{ ref('users') }}").program;
        const table = bind(program, { columnsOf: () => undefined }).scopes.flatMap(s => s.tables)[0];
        expect(table.table).toBe('users');
        expect(table.columns).toBeUndefined();
    });
});

describe('completing inside a tag', () => {
    const at = (text: string) => dbtCompletionAt(text.replace('|', ''), text.indexOf('|'));

    it('offers models inside ref', () => {
        const request = at("SELECT * FROM {{ ref('|') }}");
        expect(request).toMatchObject({ kind: 'model', prefix: '' });
        expect(dbtCompletionItems(request!, manifest())).toEqual(['countries', 'orders', 'users']);
    });

    it('works while the tag is still being typed', () => {
        expect(at("SELECT * FROM {{ ref('us|")).toMatchObject({ kind: 'model', prefix: 'us' });
    });

    it('offers source names first, then that source\'s tables', () => {
        const first = at("SELECT * FROM {{ source('|') }}");
        expect(dbtCompletionItems(first!, manifest())).toEqual(['raw']);

        const second = at("SELECT * FROM {{ source('raw', '|') }}");
        expect(second).toMatchObject({ kind: 'sourceTable', sourceName: 'raw' });
        expect(dbtCompletionItems(second!, manifest())).toEqual(['clicks', 'events']);
    });

    it('replaces what is inside the quotes, not the quotes', () => {
        const text = "SELECT * FROM {{ ref('users') }}";
        const request = dbtCompletionAt(text, text.indexOf('users') + 2)!;
        expect(text.slice(request.start, request.end)).toBe('users');
    });

    it('offers nothing outside a tag', () => {
        expect(at("SELECT 'us|er' FROM t")).toBeUndefined();
        expect(at('SELECT * FROM |users')).toBeUndefined();
        expect(at("SELECT * FROM {{ ref('users') }} WHERE a = '|'")).toBeUndefined();
    });

    it('offers nothing for a call that is not ref or source', () => {
        expect(at("SELECT {{ var('|') }}")).toBeUndefined();
    });
});
