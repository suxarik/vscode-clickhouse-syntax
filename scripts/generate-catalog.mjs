#!/usr/bin/env node
/**
 * Generate the ClickHouse catalog from a real ClickHouse server.
 *
 * Everything the extension knows about functions, data types, engines, settings,
 * formats, keywords and the `system` database is read out of the server's own
 * introspection tables, so the catalog is complete and cannot drift from the
 * dialect. The generated modules under src/catalog/generated are committed;
 * regeneration is a maintainer task, not a build step.
 *
 * Usage:
 *   node scripts/generate-catalog.mjs                 # start a throwaway container
 *   node scripts/generate-catalog.mjs --container ch  # use a running container
 *   node scripts/generate-catalog.mjs --keep          # leave the container running
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'src', 'catalog', 'generated');
const ASSET_DIR = join(ROOT, 'catalog');
const GRAMMAR = join(ROOT, 'syntaxes', 'clickhouse.tmLanguage.json');

const args = process.argv.slice(2);
const flag = name => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
};
const has = name => args.includes(`--${name}`);

const IMAGE = flag('image') ?? 'clickhouse/clickhouse-server:latest';
const OWNED_CONTAINER = 'ch-catalog-generate';
let container = flag('container');
let startedByUs = false;

// ── Server plumbing ──────────────────────────────────────────────────────────

function docker(subcommand, options = {}) {
    return execFileSync('docker', subcommand, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, ...options });
}

function startServer() {
    console.log(`Starting ${IMAGE} …`);
    try {
        docker(['rm', '-f', OWNED_CONTAINER], { stdio: 'ignore' });
    } catch {
        // Not running; nothing to remove.
    }
    docker(['run', '-d', '--name', OWNED_CONTAINER, '-e', 'CLICKHOUSE_SKIP_USER_SETUP=1', IMAGE]);
    container = OWNED_CONTAINER;
    startedByUs = true;

    const deadline = Date.now() + 120_000;
    for (;;) {
        try {
            docker(['exec', container, 'clickhouse-client', '--query', 'SELECT 1'], { stdio: 'ignore' });
            return;
        } catch {
            if (Date.now() > deadline) throw new Error('ClickHouse did not become ready within 120s');
            execFileSync('sleep', ['2']);
        }
    }
}

function stopServer() {
    if (!startedByUs || has('keep')) return;
    console.log('Stopping container …');
    try {
        docker(['rm', '-f', container], { stdio: 'ignore' });
    } catch {
        // Already gone.
    }
}

/** Run a query and return the rows as objects. */
function query(sql) {
    const out = docker(['exec', container, 'clickhouse-client', '--query', sql, '--format', 'JSONEachRow']);
    return out
        .split('\n')
        .filter(line => line.trim())
        .map(line => JSON.parse(line));
}

/** Column names of a system table, so the script survives version differences. */
function columnsOf(table) {
    return new Set(
        query(`SELECT name FROM system.columns WHERE database = 'system' AND table = '${table}'`).map(r => r.name)
    );
}

/** Build a SELECT list from the columns that actually exist. */
function pick(available, wanted) {
    return wanted.filter(name => available.has(name));
}

// ── Markdown cleanup ─────────────────────────────────────────────────────────

/** `[text](url)` -> `text`, and drop doc-site artefacts. */
function stripLinks(text) {
    return text
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\{#[^}]*\}/g, '');
}

function collapse(text) {
    return text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/** First prose paragraph, kept short enough for a completion detail row. */
function firstParagraph(text) {
    const cleaned = collapse(stripLinks(text));
    if (!cleaned) return '';
    const paragraph = cleaned.split(/\n\s*\n/)[0].replace(/\n/g, ' ').trim();
    return paragraph.length > 400 ? `${paragraph.slice(0, 397)}…` : paragraph;
}

/** Argument bullets -> [{ name, description }]. */
function parseArguments(text) {
    if (!text) return [];
    const out = [];
    for (const rawLine of stripLinks(text).split('\n')) {
        const line = rawLine.trim();
        const match = line.match(/^[-*]\s+`?([^`—:]+?)`?\s*[—:-]\s*(.*)$/);
        if (!match) continue;
        const name = match[1].trim();
        if (!name || name.length > 60) continue;
        const description = collapse(match[2]).replace(/\s+$/, '');
        out.push(description ? { name, description: description.slice(0, 200) } : { name });
    }
    return out;
}

/** The first `sql` fenced block, which is the runnable half of the examples. */
function firstExample(text) {
    if (!text) return '';
    const match = text.match(/```sql[^\n]*\n([\s\S]*?)```/);
    if (!match) return '';
    const body = match[1]
        .split('\n')
        .filter(line => !line.trim().startsWith('--') || line.trim().length < 100)
        .join('\n')
        .trim();
    return body.length > 500 ? '' : body;
}

/** Snippet body: `name(${1:arg}, ${2:arg})` from the parsed arguments. */
function snippetFor(name, syntax, argumentList) {
    if (!syntax || !syntax.includes('(')) return `${name}($0)`;
    const names = argumentList.map(a => a.name.replace(/[^A-Za-z0-9_]/g, '')).filter(Boolean);
    if (names.length === 0) return `${name}($0)`;
    const placeholders = names.slice(0, 6).map((argument, index) => `\${${index + 1}:${argument}}`);
    return `${name}(${placeholders.join(', ')})`;
}

// ── Category mapping ─────────────────────────────────────────────────────────

const CATEGORY_GROUPS = {
    aggregate: ['Aggregate Functions'],
    array: ['Arrays'],
    string: [
        'String', 'String Search', 'String Splitting', 'String Replacement',
        'Natural Language Processing', 'Encoding', 'Encryption', 'Hash',
    ],
    date: ['Dates and Times', 'Time Window', 'Time Series'],
    math: ['Mathematical', 'Arithmetic', 'Rounding', 'Bit', 'Distance', 'Random Number', 'Comparison'],
    type: ['Type Conversion'],
    conditional: ['Conditional', 'Null'],
};

const CATEGORY_TO_GROUP = new Map();
for (const [group, categories] of Object.entries(CATEGORY_GROUPS)) {
    for (const category of categories) CATEGORY_TO_GROUP.set(category, group);
}

function groupFor(fn) {
    if (fn.aggregate) return 'aggregate';
    const category = (fn.categories ?? '').split(',')[0].trim();
    return CATEGORY_TO_GROUP.get(category) ?? 'other';
}

// ── Emitters ─────────────────────────────────────────────────────────────────

const HEADER = `/**
 * GENERATED FILE — DO NOT EDIT.
 * Produced by scripts/generate-catalog.mjs from a live ClickHouse server.
 */
`;

/**
 * Emit data as a JSON string literal rather than an object literal: the string
 * is cheaper for the engine to hold and only costs a JSON.parse on first use.
 */
function emitModule(file, exportName, data, typeName, importType) {
    const json = JSON.stringify(JSON.stringify(data));
    const importLine = importType ? `import type { ${importType} } from '../types';\n` : '';
    const body = `${HEADER}${importLine}
export const ${exportName}_JSON: string = ${json};

let cache: ${typeName} | undefined;

/** Parsed on first use, then cached. */
export function ${exportName}(): ${typeName} {
    if (cache === undefined) cache = JSON.parse(${exportName}_JSON) as ${typeName};
    return cache;
}
`;
    writeFileSync(join(OUT_DIR, file), body, 'utf8');
    return json.length;
}

/**
 * Emit a lazily-loaded asset. These never enter the bundle; the extension reads
 * them from disk the first time hover or signature help actually needs them.
 */
function emitAsset(file, data) {
    mkdirSync(ASSET_DIR, { recursive: true });
    const json = JSON.stringify(data);
    writeFileSync(join(ASSET_DIR, file), json, 'utf8');
    return json.length;
}

// ── Grammar regeneration ─────────────────────────────────────────────────────

const GRAMMAR_SCOPES = {
    aggregate: 'support.function.aggregate.sql.clickhouse',
    array: 'support.function.array.sql.clickhouse',
    string: 'support.function.string.sql.clickhouse',
    date: 'support.function.date.sql.clickhouse',
    math: 'support.function.math.sql.clickhouse',
    type: 'support.function.type.sql.clickhouse',
    conditional: 'support.function.conditional.sql.clickhouse',
    other: 'support.function.other.sql.clickhouse',
};

/** Longest name first, so `toDate` cannot shadow `toDateTime64`. */
function alternation(names) {
    return [...new Set(names)]
        .sort((a, b) => b.length - a.length || a.localeCompare(b))
        .map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|');
}

function regenerateGrammar(functions, dataTypes, engines) {
    const grammar = JSON.parse(readFileSync(GRAMMAR, 'utf8'));
    const byGroup = new Map(Object.keys(GRAMMAR_SCOPES).map(group => [group, []]));
    for (const fn of functions) {
        byGroup.get(fn.group)?.push(fn.name);
    }

    for (const [group, scope] of Object.entries(GRAMMAR_SCOPES)) {
        const names = byGroup.get(group) ?? [];
        if (names.length === 0) continue;
        grammar.repository[`ch-${group}-functions`] = {
            patterns: [{ name: scope, match: `(?i)\\b(${alternation(names)})(?=\\s*\\()` }],
        };
    }

    // Data types keep their existing sub-scopes; only the catch-all list is regenerated.
    const knownTypeNames = dataTypes.map(t => t.name);
    grammar.repository['ch-data-types'] = {
        patterns: [
            {
                name: 'storage.type.sql.clickhouse',
                match: `\\b(${alternation(knownTypeNames)})\\b`,
            },
        ],
    };

    const mergeTree = engines.filter(e => /MergeTree$/.test(e.name)).map(e => e.name);
    const otherEngines = engines.filter(e => !/MergeTree$/.test(e.name)).map(e => e.name);
    grammar.repository['ch-engines'] = {
        patterns: [
            { name: 'support.class.engine.mergetree.sql.clickhouse', match: `\\b(${alternation(mergeTree)})\\b` },
            { name: 'support.class.engine.special.sql.clickhouse', match: `\\b(${alternation(otherEngines)})\\b` },
        ],
    };

    writeFileSync(GRAMMAR, `${JSON.stringify(grammar, null, 2)}\n`, 'utf8');
    return { functionCount: functions.length, typeCount: knownTypeNames.length, engineCount: engines.length };
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
    if (!container) startServer();
    mkdirSync(OUT_DIR, { recursive: true });

    const version = query('SELECT version() AS v')[0].v;
    console.log(`Reading catalog from ClickHouse ${version}`);

    // Functions
    const fnColumns = columnsOf('functions');
    const fnSelect = pick(fnColumns, [
        'name', 'is_aggregate', 'case_insensitive', 'alias_to', 'description', 'syntax',
        'arguments', 'parameters', 'returned_value', 'examples', 'introduced_in',
        'categories', 'deterministic', 'higher_order',
    ]);
    const rawFunctions = query(
        `SELECT ${fnSelect.join(', ')} FROM system.functions WHERE origin = 'System' ORDER BY name`
    );

    const functions = rawFunctions.map(row => {
        const argumentList = parseArguments(row.arguments ?? '');
        const fn = {
            name: row.name,
            group: '',
            categories: (row.categories ?? '').split(',').map(c => c.trim()).filter(Boolean),
        };
        if (Number(row.is_aggregate)) fn.aggregate = true;
        if (Number(row.case_insensitive)) fn.caseInsensitive = true;
        if (row.alias_to) fn.aliasTo = row.alias_to;
        if (Number(row.higher_order)) fn.higherOrder = true;
        if (row.deterministic !== null && row.deterministic !== undefined && !Number(row.deterministic)) {
            fn.nonDeterministic = true;
        }
        const description = firstParagraph(row.description ?? '');
        if (description) fn.description = description;
        const syntax = collapse(stripLinks(row.syntax ?? ''));
        if (syntax) fn.syntax = syntax;
        if (argumentList.length > 0) fn.args = argumentList;
        const returns = firstParagraph(row.returned_value ?? '');
        if (returns) fn.returns = returns;
        const example = firstExample(row.examples ?? '');
        if (example) fn.example = example;
        if (row.introduced_in && row.introduced_in !== '0.0.0') fn.since = row.introduced_in;
        fn.snippet = snippetFor(row.name, syntax, argumentList);
        return fn;
    });
    for (const fn of functions) fn.group = groupFor({ ...fn, categories: fn.categories.join(',') });

    // Data types
    const typeColumns = columnsOf('data_type_families');
    const dataTypes = query(
        `SELECT ${pick(typeColumns, ['name', 'case_insensitive', 'alias_to']).join(', ')} ` +
            `FROM system.data_type_families ORDER BY name`
    ).map(row => {
        const type = { name: row.name };
        if (Number(row.case_insensitive)) type.caseInsensitive = true;
        if (row.alias_to) type.aliasTo = row.alias_to;
        return type;
    });

    // Table engines
    const engineColumns = columnsOf('table_engines');
    const engines = query(
        `SELECT ${pick(engineColumns, [
            'name', 'supports_settings', 'supports_skipping_indices', 'supports_sort_order',
            'supports_ttl', 'supports_replication', 'supports_deduplication', 'supports_parallel_insert',
        ]).join(', ')} FROM system.table_engines ORDER BY name`
    ).map(row => {
        const engine = { name: row.name };
        const supports = [];
        if (Number(row.supports_sort_order)) supports.push('sortOrder');
        if (Number(row.supports_ttl)) supports.push('ttl');
        if (Number(row.supports_skipping_indices)) supports.push('skippingIndices');
        if (Number(row.supports_replication)) supports.push('replication');
        if (Number(row.supports_deduplication)) supports.push('deduplication');
        if (Number(row.supports_settings)) supports.push('settings');
        if (Number(row.supports_parallel_insert)) supports.push('parallelInsert');
        if (supports.length > 0) engine.supports = supports;
        return engine;
    });

    // Settings (query-level and MergeTree)
    const settingColumns = columnsOf('settings');
    const settings = query(
        `SELECT ${pick(settingColumns, ['name', 'type', 'default', 'description', 'tier']).join(', ')} ` +
            `FROM system.settings ORDER BY name`
    ).map(row => {
        const setting = { name: row.name, type: row.type };
        if (row.default !== undefined && row.default !== '') setting.default = String(row.default);
        const description = firstParagraph(row.description ?? '');
        if (description) setting.description = description;
        if (row.tier && row.tier !== 'Production') setting.tier = row.tier;
        return setting;
    });

    const mergeTreeColumns = columnsOf('merge_tree_settings');
    const mergeTreeSettings = query(
        `SELECT ${pick(mergeTreeColumns, ['name', 'type', 'default', 'description', 'tier']).join(', ')} ` +
            `FROM system.merge_tree_settings ORDER BY name`
    ).map(row => {
        const setting = { name: row.name, type: row.type, mergeTree: true };
        if (row.default !== undefined && row.default !== '') setting.default = String(row.default);
        const description = firstParagraph(row.description ?? '');
        if (description) setting.description = description;
        if (row.tier && row.tier !== 'Production') setting.tier = row.tier;
        return setting;
    });

    // Formats
    const formatColumns = columnsOf('formats');
    const formats = query(
        `SELECT ${pick(formatColumns, ['name', 'is_input', 'is_output']).join(', ')} FROM system.formats ORDER BY name`
    ).map(row => {
        const format = { name: row.name };
        if (Number(row.is_input)) format.input = true;
        if (Number(row.is_output)) format.output = true;
        return format;
    });

    // Keywords
    const keywords = query('SELECT keyword FROM system.keywords ORDER BY keyword').map(row => row.keyword);

    // The system database, so `FROM system.query_log` works with no user schema.
    const systemColumns = query(
        `SELECT table, name, type, comment FROM system.columns WHERE database = 'system' ORDER BY table, position`
    );
    const systemTableRows = query(
        `SELECT name, engine, comment FROM system.tables WHERE database = 'system' ORDER BY name`
    );
    const systemTables = systemTableRows.map(row => ({
        name: row.name,
        engine: row.engine,
        comment: firstParagraph(row.comment ?? ''),
        columns: systemColumns
            .filter(column => column.table === row.name)
            .map(column => {
                const entry = { name: column.name, type: column.type };
                const comment = firstParagraph(column.comment ?? '');
                if (comment) entry.comment = comment;
                return entry;
            }),
    })).filter(table => table.columns.length > 0);

    // ── Write ──
    // Two tiers. The bundled tier holds what completion and signature help need
    // on the keystroke path; prose lives in assets that are read from disk only
    // when hover or a completion resolve actually asks for it.
    const bundledFunctions = functions.map(fn => {
        const compact = { name: fn.name, group: fn.group, snippet: fn.snippet };
        if (fn.syntax) compact.syntax = fn.syntax;
        if (fn.aggregate) compact.aggregate = true;
        if (fn.caseInsensitive) compact.caseInsensitive = true;
        if (fn.higherOrder) compact.higherOrder = true;
        if (fn.nonDeterministic) compact.nonDeterministic = true;
        if (fn.aliasTo) compact.aliasTo = fn.aliasTo;
        if (fn.since) compact.since = fn.since;
        if (fn.categories.length > 0) compact.category = fn.categories[0];
        return compact;
    });

    const functionDocs = {};
    for (const fn of functions) {
        const doc = {};
        if (fn.description) doc.description = fn.description;
        if (fn.args && fn.args.length > 0) doc.args = fn.args;
        if (fn.returns) doc.returns = fn.returns;
        if (fn.example) doc.example = fn.example;
        if (Object.keys(doc).length > 0) functionDocs[fn.name] = doc;
    }

    const allSettings = [...settings, ...mergeTreeSettings];
    const bundledSettings = allSettings.map(setting => {
        const compact = { name: setting.name, type: setting.type };
        if (setting.default !== undefined) compact.default = setting.default;
        if (setting.tier) compact.tier = setting.tier;
        if (setting.mergeTree) compact.mergeTree = true;
        return compact;
    });
    const settingDocs = {};
    for (const setting of allSettings) {
        if (setting.description) settingDocs[setting.name] = setting.description;
    }

    const sizes = {};
    sizes['functions (bundled)'] = emitModule(
        'functions.ts', 'catalogFunctions', bundledFunctions, 'CatalogFunction[]', 'CatalogFunction'
    );
    sizes['dataTypes (bundled)'] = emitModule(
        'dataTypes.ts', 'catalogDataTypes', dataTypes, 'CatalogDataType[]', 'CatalogDataType'
    );
    sizes['engines (bundled)'] = emitModule(
        'engines.ts', 'catalogEngines', engines, 'CatalogEngine[]', 'CatalogEngine'
    );
    sizes['settings (bundled)'] = emitModule(
        'settings.ts', 'catalogSettings', bundledSettings, 'CatalogSetting[]', 'CatalogSetting'
    );
    sizes['formats (bundled)'] = emitModule(
        'formats.ts', 'catalogFormats', formats, 'CatalogFormat[]', 'CatalogFormat'
    );
    sizes['keywords (bundled)'] = emitModule('keywords.ts', 'catalogKeywords', keywords, 'string[]');

    sizes['function-docs (asset)'] = emitAsset('function-docs.json', functionDocs);
    sizes['setting-docs (asset)'] = emitAsset('setting-docs.json', settingDocs);
    sizes['system-tables (asset)'] = emitAsset('system-tables.json', systemTables);

    writeFileSync(
        join(OUT_DIR, 'meta.ts'),
        `${HEADER}
/** ClickHouse version this catalog was read from. */
export const CATALOG_VERSION = ${JSON.stringify(version)};

/** UTC date of generation. */
export const CATALOG_GENERATED_AT = ${JSON.stringify(new Date().toISOString().slice(0, 10))};

export const CATALOG_COUNTS = ${JSON.stringify(
            {
                functions: functions.length,
                documentedFunctions: functions.filter(f => f.description).length,
                dataTypes: dataTypes.length,
                engines: engines.length,
                settings: allSettings.length,
                formats: formats.length,
                keywords: keywords.length,
                systemTables: systemTables.length,
            },
            null,
            4
        )};
`,
        'utf8'
    );

    const grammarStats = regenerateGrammar(functions, dataTypes, engines);

    console.log('');
    console.log(`ClickHouse       ${version}`);
    console.log(`functions        ${functions.length} (${functions.filter(f => f.description).length} documented)`);
    console.log(`data types       ${dataTypes.length}`);
    console.log(`table engines    ${engines.length}`);
    console.log(`settings         ${settings.length} + ${mergeTreeSettings.length} MergeTree`);
    console.log(`formats          ${formats.length}`);
    console.log(`keywords         ${keywords.length}`);
    console.log(`system tables    ${systemTables.length}`);
    console.log('');
    for (const [name, size] of Object.entries(sizes)) {
        console.log(`  ${name.padEnd(14)} ${(size / 1024).toFixed(1)} KB`);
    }
    console.log(`\ngrammar regenerated: ${grammarStats.functionCount} functions, ${grammarStats.typeCount} types, ${grammarStats.engineCount} engines`);
}

try {
    main();
} finally {
    stopServer();
}
