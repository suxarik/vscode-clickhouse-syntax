/**
 * Completion for ClickHouse SQL.
 *
 * Suggestions follow the cursor's clause and the tables actually in scope, so a
 * qualified prefix such as `e.` offers the columns of whatever `e` aliases
 * rather than every column in the schema. Clause-specific lists — settings,
 * output formats, table engines — come from the generated catalog, as do all
 * ~1900 functions. Documentation is filled in on resolve so building the list
 * never touches an asset file.
 */
import * as vscode from 'vscode';
import { SchemaManager } from '../schemaManager';
import { CH_KEYWORDS } from '../constants';
import { getSqlContext, isAfterDot, SqlContext } from '../sqlContext';
import { SchemaColumn } from '../types';
import { Catalog, isAvailableIn, functionDetail, CatalogSystemTable } from '../catalog';
import { AnalysisCache } from '../analysis';
import { BoundTable, scopeAt, visibleCtes, visibleTables } from '../parser/binder';
import { resolveFunction, resolveFunctionSync } from '../functionInfo';
import { CH_FUNCTION_DOCS } from '../functionDocs';

/** Sort buckets. Lower sorts first in the completion list. */
const enum Rank {
    ClauseSpecific = 0,
    ScopedColumn = 1,
    Table = 2,
    Database = 3,
    OtherColumn = 4,
    Keyword = 5,
    Function = 6,
    DataType = 7,
}

const TABLE_CLAUSES = new Set(['FROM', 'JOIN', 'INSERT INTO', 'ALTER TABLE', 'CREATE TABLE', 'INTO']);
const COLUMN_CLAUSES = new Set([
    'SELECT', 'WHERE', 'PREWHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'QUALIFY',
    'ON', 'USING', 'LIMIT BY', 'PARTITION BY', 'SAMPLE BY', 'PRIMARY KEY', 'WINDOW', 'SET', 'TTL',
]);

/** Carried on an item so `resolveCompletionItem` knows what to document. */
interface Resolvable extends vscode.CompletionItem {
    chFunction?: string;
    chSetting?: string;
}

function rankSort(rank: Rank, label: string): string {
    return `${rank}${label.toLowerCase()}`;
}

function columnItem(column: SchemaColumn, tableName: string, rank: Rank, insertText?: string): vscode.CompletionItem {
    const item = new vscode.CompletionItem(column.name, vscode.CompletionItemKind.Field);
    item.detail = `${column.type} — ${tableName}`;
    const docs = new vscode.MarkdownString();
    if (column.description) docs.appendMarkdown(`${column.description}\n\n`);
    docs.appendMarkdown(`**Type:** \`${column.type}\``);
    if (column.defaultValue) docs.appendMarkdown(`\n\n**Default:** \`${column.defaultValue}\``);
    if (column.codec) docs.appendMarkdown(`\n\n**Codec:** \`${column.codec}\``);
    item.documentation = docs;
    item.sortText = rankSort(rank, column.name);
    if (insertText) item.insertText = insertText;
    return item;
}

function systemColumnItems(table: CatalogSystemTable, rank: Rank): vscode.CompletionItem[] {
    return table.columns.map(column => {
        const item = new vscode.CompletionItem(column.name, vscode.CompletionItemKind.Field);
        item.detail = `${column.type} — system.${table.name}`;
        if (column.comment) item.documentation = new vscode.MarkdownString(column.comment);
        item.sortText = rankSort(rank, column.name);
        return item;
    });
}

/** Resolve an alias, CTE or table name against the bound tables in scope. */
function resolveQualifier(qualifier: string, tables: BoundTable[]): BoundTable | undefined {
    const lower = qualifier.toLowerCase();
    return (
        tables.find(table => table.alias?.toLowerCase() === lower) ??
        tables.find(table => table.table?.toLowerCase() === lower) ??
        tables.find(table => table.label.toLowerCase() === lower)
    );
}

/** Completion items for a bound table's columns, with types where known. */
function boundTableColumns(
    table: BoundTable,
    schemaManager: SchemaManager,
    catalog: Catalog,
    rank: Rank,
    qualifyWith?: string
): vscode.CompletionItem[] {
    const label = qualifyWith ?? table.label;

    // A real table has typed columns; a CTE or subquery only has names.
    if (table.kind === 'table' && table.table) {
        if (table.database?.toLowerCase() === 'system') {
            const systemTable = catalog.systemTableSync(table.table);
            if (systemTable) return systemColumnItems(systemTable, rank);
        }
        const found = schemaManager.findTable(table.table, table.database);
        if (found) {
            return found.table.columns.map(column => {
                const item = columnItem(column, label, rank);
                if (qualifyWith) {
                    item.label = `${qualifyWith}.${column.name}`;
                    item.insertText = `${qualifyWith}.${column.name}`;
                }
                return item;
            });
        }
        const systemTable = catalog.systemTableSync(table.table);
        if (systemTable) return systemColumnItems(systemTable, rank);
    }

    return (table.columns ?? []).map(name => {
        const item = new vscode.CompletionItem(
            qualifyWith ? `${qualifyWith}.${name}` : name,
            vscode.CompletionItemKind.Field
        );
        item.detail = table.kind === 'cte' ? `column of CTE ${table.label}` : `column of ${table.label}`;
        item.sortText = rankSort(rank, name);
        if (qualifyWith) item.insertText = `${qualifyWith}.${name}`;
        return item;
    });
}

// ── Clause-specific lists ────────────────────────────────────────────────────

function settingItems(catalog: Catalog, mergeTreeOnly: boolean): Resolvable[] {
    return catalog
        .settings()
        .filter(setting => (mergeTreeOnly ? setting.mergeTree : !setting.mergeTree))
        .map(setting => {
            const item: Resolvable = new vscode.CompletionItem(setting.name, vscode.CompletionItemKind.Property);
            item.detail = [setting.type, setting.default !== undefined ? `= ${setting.default}` : '', setting.tier]
                .filter(Boolean)
                .join(' ');
            item.sortText = rankSort(Rank.ClauseSpecific, setting.name);
            item.chSetting = setting.name;
            return item;
        });
}

function formatItems(catalog: Catalog): vscode.CompletionItem[] {
    return catalog.formats().map(format => {
        const item = new vscode.CompletionItem(format.name, vscode.CompletionItemKind.EnumMember);
        const direction = [format.input ? 'input' : '', format.output ? 'output' : ''].filter(Boolean).join('/');
        item.detail = `format${direction ? ` — ${direction}` : ''}`;
        item.sortText = rankSort(Rank.ClauseSpecific, format.name);
        return item;
    });
}

function engineItems(catalog: Catalog): vscode.CompletionItem[] {
    return catalog.engines().map(engine => {
        const item = new vscode.CompletionItem(engine.name, vscode.CompletionItemKind.Class);
        item.detail = 'table engine';
        if (engine.supports && engine.supports.length > 0) {
            item.documentation = new vscode.MarkdownString(`Supports: ${engine.supports.join(', ')}`);
        }
        item.sortText = rankSort(Rank.ClauseSpecific, engine.name);
        return item;
    });
}

// ── Schema completions ───────────────────────────────────────────────────────

function addSchemaCompletions(
    items: vscode.CompletionItem[],
    schemaManager: SchemaManager,
    catalog: Catalog,
    context: SqlContext,
    tables: BoundTable[],
    config: vscode.WorkspaceConfiguration
): void {
    const schema = schemaManager.getSchema();
    if (!schema) return;

    const clause = context.clause;
    const wantTables = config.get<boolean>('completion.includeTables', true);
    const wantColumns = config.get<boolean>('completion.includeColumns', true);
    const wantQualified = config.get<boolean>('completion.includeQualifiedNames', true);

    if (wantTables && (TABLE_CLAUSES.has(clause) || clause === '')) {
        for (const db of schema.databases) {
            const dbItem = new vscode.CompletionItem(db.name, vscode.CompletionItemKind.Module);
            dbItem.detail = 'Database';
            if (db.description) dbItem.documentation = new vscode.MarkdownString(db.description);
            dbItem.sortText = rankSort(Rank.Database, db.name);
            items.push(dbItem);

            for (const table of db.tables) {
                const item = new vscode.CompletionItem(table.name, vscode.CompletionItemKind.Class);
                item.detail = `Table — ${db.name}${table.engine ? ` (${table.engine})` : ''}`;
                const docs = new vscode.MarkdownString();
                if (table.description) docs.appendMarkdown(`${table.description}\n\n`);
                docs.appendMarkdown(`**Engine:** \`${table.engine || 'unknown'}\`\n\n`);
                docs.appendMarkdown(`**Columns:** ${table.columns.length}`);
                item.documentation = docs;
                item.sortText = rankSort(Rank.Table, table.name);
                items.push(item);

                if (wantQualified) {
                    const fq = new vscode.CompletionItem(`${db.name}.${table.name}`, vscode.CompletionItemKind.Class);
                    fq.detail = `Table — ${db.name}`;
                    fq.sortText = rankSort(Rank.Table, `${db.name}.${table.name}`);
                    items.push(fq);
                }
            }
        }
    }

    if (!wantColumns) return;
    if (!COLUMN_CLAUSES.has(clause) && clause !== '') return;

    const needsQualifier = tables.length > 1;
    let produced = 0;

    for (const table of tables) {
        const columns = boundTableColumns(table, schemaManager, catalog, Rank.ScopedColumn);
        produced += columns.length;
        items.push(...columns);
        if (needsQualifier && table.label) {
            items.push(...boundTableColumns(table, schemaManager, catalog, Rank.ScopedColumn, table.label));
        }
    }

    // Without a resolvable FROM, fall back to every column the schema knows.
    if (produced === 0) {
        const added = new Set<string>();
        for (const entry of schemaManager.getAllColumns()) {
            if (added.has(entry.column.name.toLowerCase())) continue;
            added.add(entry.column.name.toLowerCase());
            items.push(columnItem(entry.column, entry.table, Rank.OtherColumn));
        }
    }
}

// ── Entry point ──────────────────────────────────────────────────────────────

export async function buildCompletions(
    context: SqlContext,
    dotCheck: { isAfter: boolean; prefix: string; qualifier: string[] },
    schemaManager: SchemaManager,
    catalog: Catalog,
    config: vscode.WorkspaceConfiguration,
    /** Tables the binder resolved at the cursor; falls back to none. */
    tables: BoundTable[] = [],
    /** CTE names visible at the cursor. */
    ctes: string[] = []
): Promise<vscode.CompletionItem[]> {
    const items: vscode.CompletionItem[] = [];

    // Inside a string or comment there is nothing useful to offer.
    if (context.inString || context.inComment) return items;

    // ── Qualified prefix: alias., table., database., system. ──
    if (dotCheck.isAfter) {
        const qualifier = dotCheck.prefix;

        if (qualifier.toLowerCase() === 'system') {
            for (const table of await catalog.systemTables()) {
                const item = new vscode.CompletionItem(table.name, vscode.CompletionItemKind.Class);
                item.detail = `system table — ${table.engine}`;
                if (table.comment) item.documentation = new vscode.MarkdownString(table.comment);
                item.sortText = rankSort(Rank.ClauseSpecific, table.name);
                items.push(item);
            }
            return items;
        }

        const bound = resolveQualifier(qualifier, tables);
        if (bound) {
            if (bound.database?.toLowerCase() === 'system' && bound.table) {
                const systemTable = await catalog.systemTable(bound.table);
                if (systemTable) return systemColumnItems(systemTable, Rank.ScopedColumn);
            }
            const columns = boundTableColumns(bound, schemaManager, catalog, Rank.ScopedColumn);
            if (columns.length > 0) return columns;
        }

        const schema = schemaManager.getSchema();
        const table = schemaManager.findTable(
            qualifier,
            dotCheck.qualifier.length > 1 ? dotCheck.qualifier[dotCheck.qualifier.length - 2] : undefined
        );
        if (table) {
            return table.table.columns.map(column => columnItem(column, table.table.name, Rank.ScopedColumn));
        }

        const db = schema?.databases.find(d => d.name.toLowerCase() === qualifier.toLowerCase());
        if (db) {
            for (const tbl of db.tables) {
                const item = new vscode.CompletionItem(tbl.name, vscode.CompletionItemKind.Class);
                item.detail = `Table — ${db.name}${tbl.engine ? ` (${tbl.engine})` : ''}`;
                item.sortText = rankSort(Rank.Table, tbl.name);
                items.push(item);
            }
        }
        return items;
    }

    // ── Clause-specific lists replace the general ones ──
    const clause = context.clause;
    if (clause === 'SETTINGS') {
        return settingItems(catalog, false);
    }
    if (clause === 'FORMAT') {
        return formatItems(catalog);
    }
    if (clause === 'ENGINE') {
        return engineItems(catalog);
    }

    addSchemaCompletions(items, schemaManager, catalog, context, tables, config);

    if (TABLE_CLAUSES.has(clause)) {
        for (const cte of ctes) {
            const item = new vscode.CompletionItem(cte, vscode.CompletionItemKind.Class);
            item.detail = 'Common table expression';
            item.sortText = rankSort(Rank.Table, cte);
            items.push(item);
        }
        const systemDb = new vscode.CompletionItem('system', vscode.CompletionItemKind.Module);
        systemDb.detail = 'ClickHouse system database';
        systemDb.sortText = rankSort(Rank.Database, 'system');
        items.push(systemDb);
    }

    if (config.get<boolean>('completion.includeKeywords', true)) {
        for (const keyword of CH_KEYWORDS) {
            const item = new vscode.CompletionItem(keyword, vscode.CompletionItemKind.Keyword);
            item.detail = 'ClickHouse keyword';
            item.sortText = rankSort(Rank.Keyword, keyword);
            items.push(item);
        }
    }

    if (config.get<boolean>('completion.includeFunctions', true)) {
        const serverVersion = config.get<string>('serverVersion', 'auto');
        const seen = new Set<string>();
        for (const fn of catalog.functions()) {
            if (!isAvailableIn(fn.since, serverVersion)) continue;
            seen.add(fn.name.toLowerCase());
            const item: Resolvable = new vscode.CompletionItem(fn.name, vscode.CompletionItemKind.Function);
            item.detail = functionDetail(fn);
            item.insertText = new vscode.SnippetString(
                CH_FUNCTION_DOCS[fn.name.toLowerCase()]?.insertText ?? fn.snippet
            );
            item.sortText = rankSort(Rank.Function, fn.name);
            item.chFunction = fn.name;
            items.push(item);
        }
        // Curated-only entries, for catalogs older than the curated table.
        for (const curated of Object.values(CH_FUNCTION_DOCS)) {
            if (seen.has(curated.name.toLowerCase())) continue;
            const item: Resolvable = new vscode.CompletionItem(curated.name, vscode.CompletionItemKind.Function);
            item.detail = curated.category ?? 'function';
            if (curated.insertText) item.insertText = new vscode.SnippetString(curated.insertText);
            item.sortText = rankSort(Rank.Function, curated.name);
            item.chFunction = curated.name;
            items.push(item);
        }
    }

    if (config.get<boolean>('completion.includeDataTypes', true)) {
        for (const type of catalog.dataTypes()) {
            const item = new vscode.CompletionItem(type.name, vscode.CompletionItemKind.TypeParameter);
            item.detail = type.aliasTo ? `data type — alias of ${type.aliasTo}` : 'ClickHouse data type';
            item.sortText = rankSort(Rank.DataType, type.name);
            items.push(item);
        }
    }

    const maxItems = config.get<number>('completion.maxItems', 0);
    if (maxItems > 0 && items.length > maxItems) {
        items.sort((a, b) => (a.sortText ?? '').localeCompare(b.sortText ?? ''));
        return items.slice(0, maxItems);
    }
    return items;
}

/** Fill in documentation for the item the user is looking at. */
export async function resolveCompletion(item: Resolvable, catalog: Catalog): Promise<vscode.CompletionItem> {
    if (item.documentation) return item;

    if (item.chFunction) {
        const fn = await resolveFunction(item.chFunction, catalog);
        if (fn) {
            const md = new vscode.MarkdownString();
            if (fn.description) md.appendMarkdown(`${fn.description}\n\n`);
            if (fn.signature) md.appendCodeblock(fn.signature, 'sql');
            if (fn.args && fn.args.length > 0) {
                md.appendMarkdown('\n');
                for (const arg of fn.args) {
                    md.appendMarkdown(`- \`${arg.name}\`${arg.description ? ` — ${arg.description}` : ''}\n`);
                }
            }
            if (fn.returns) md.appendMarkdown(`\n**Returns:** ${fn.returns}\n`);
            if (fn.example) {
                md.appendMarkdown('\n**Example:**\n');
                md.appendCodeblock(fn.example, 'sql');
            }
            item.documentation = md;
        }
        return item;
    }

    if (item.chSetting) {
        const description = await catalog.settingDoc(item.chSetting);
        if (description) item.documentation = new vscode.MarkdownString(description);
    }
    return item;
}

export function registerCompletionProvider(
    schemaManager: SchemaManager,
    catalog: Catalog,
    analysisCache: AnalysisCache
): vscode.Disposable {
    return vscode.languages.registerCompletionItemProvider(
        [{ language: 'clickhouse' }, { language: 'sql' }],
        {
            async provideCompletionItems(
                document: vscode.TextDocument,
                position: vscode.Position
            ): Promise<vscode.CompletionItem[]> {
                const config = vscode.workspace.getConfiguration('clickhouse');
                if (!config.get<boolean>('completion.enabled', true)) return [];
                try {
                    const context = getSqlContext(document, position);
                    const dotCheck = isAfterDot(document, position);
                    // Clause detection comes from the token scan, which copes with
                    // half-typed input; scope comes from the binder, which knows
                    // what CTEs and subqueries project.
                    const analysis = analysisCache.get(document);
                    const scope = scopeAt(analysis.binding, document.offsetAt(position));
                    const tables = visibleTables(scope);
                    const ctes = visibleCtes(scope).map(cte => cte.name.name);
                    return await buildCompletions(
                        context,
                        dotCheck,
                        schemaManager,
                        catalog,
                        config,
                        tables,
                        ctes
                    );
                } catch (err) {
                    console.error('ClickHouse: completion failed', err);
                    return [];
                }
            },
            async resolveCompletionItem(item: vscode.CompletionItem): Promise<vscode.CompletionItem> {
                try {
                    return await resolveCompletion(item as Resolvable, catalog);
                } catch (err) {
                    console.error('ClickHouse: completion resolve failed', err);
                    return item;
                }
            },
        },
        '.',
        '('
    );
}

export { resolveFunctionSync };
