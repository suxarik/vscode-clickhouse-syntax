/**
 * Hover documentation for ClickHouse SQL.
 *
 * Function, setting and `system` table documentation comes from the generated
 * catalog, read from its asset file the first time something asks for it.
 */
import * as vscode from 'vscode';
import { SchemaManager } from '../schemaManager';
import { getSqlContext } from '../sqlContext';
import { Catalog } from '../catalog';
import { resolveFunction } from '../functionInfo';

const DOCS_BASE = 'https://clickhouse.com/docs/en/sql-reference';

function functionDocsUrl(group: string | undefined): string {
    switch (group) {
        case 'aggregate':
            return `${DOCS_BASE}/aggregate-functions/reference`;
        case 'array':
            return `${DOCS_BASE}/functions/array-functions`;
        case 'string':
            return `${DOCS_BASE}/functions/string-functions`;
        case 'date':
            return `${DOCS_BASE}/functions/date-time-functions`;
        case 'math':
            return `${DOCS_BASE}/functions/math-functions`;
        case 'type':
            return `${DOCS_BASE}/functions/type-conversion-functions`;
        case 'conditional':
            return `${DOCS_BASE}/functions/conditional-functions`;
        default:
            return `${DOCS_BASE}/functions`;
    }
}

export async function buildHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    schemaManager: SchemaManager,
    catalog: Catalog,
    config: vscode.WorkspaceConfiguration
): Promise<vscode.Hover | undefined> {
    const range = document.getWordRangeAtPosition(position, /[a-zA-Z_][a-zA-Z0-9_]*/);
    if (!range) return undefined;

    const word = document.getText(range);
    const context = getSqlContext(document, position);
    if (context.inString || context.inComment) return undefined;

    // ── A setting, when the cursor is in a SETTINGS clause ──
    if (context.clause === 'SETTINGS') {
        const setting = catalog.settingByName(word);
        if (setting) {
            const md = new vscode.MarkdownString();
            md.appendMarkdown(`**${setting.name}** — *setting*\n\n`);
            const description = await catalog.settingDoc(setting.name);
            if (description) md.appendMarkdown(`${description}\n\n`);
            md.appendMarkdown(`**Type:** \`${setting.type}\`\n\n`);
            if (setting.default !== undefined) md.appendMarkdown(`**Default:** \`${setting.default}\`\n\n`);
            if (setting.tier) md.appendMarkdown(`⚠️ **${setting.tier}**\n\n`);
            return new vscode.Hover(md, range);
        }
    }

    // ── A table engine, after ENGINE = ──
    if (context.clause === 'ENGINE') {
        const engine = catalog.engineByName(word);
        if (engine) {
            const md = new vscode.MarkdownString();
            md.appendMarkdown(`**${engine.name}** — *table engine*\n\n`);
            if (engine.supports && engine.supports.length > 0) {
                md.appendMarkdown(`**Supports:** ${engine.supports.join(', ')}\n\n`);
            }
            md.appendMarkdown(`[Engine documentation](https://clickhouse.com/docs/en/engines/table-engines)`);
            return new vscode.Hover(md, range);
        }
    }

    // ── An output format, after FORMAT ──
    if (context.clause === 'FORMAT') {
        const format = catalog.formatByName(word);
        if (format) {
            const md = new vscode.MarkdownString();
            md.appendMarkdown(`**${format.name}** — *format*\n\n`);
            const direction = [format.input ? 'input' : '', format.output ? 'output' : ''].filter(Boolean).join(' and ');
            if (direction) md.appendMarkdown(`Usable for ${direction}.\n\n`);
            md.appendMarkdown(`[Format documentation](https://clickhouse.com/docs/en/interfaces/formats)`);
            return new vscode.Hover(md, range);
        }
    }

    // ── A function ──
    const fn = await resolveFunction(word, catalog);
    if (fn) {
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**${fn.name}** — *${fn.detail}*\n\n`);
        if (fn.description) md.appendMarkdown(`${fn.description}\n\n`);
        if (config.get<boolean>('hover.showFunctionSignature', true) && fn.signature) {
            md.appendCodeblock(fn.signature, 'sql');
        }
        if (fn.args && fn.args.length > 0) {
            for (const arg of fn.args) {
                md.appendMarkdown(`- \`${arg.name}\`${arg.description ? ` — ${arg.description}` : ''}\n`);
            }
            md.appendMarkdown('\n');
        }
        if (fn.returns) md.appendMarkdown(`**Returns:** ${fn.returns}\n\n`);
        if (config.get<boolean>('hover.showExamples', true) && fn.example) {
            md.appendMarkdown('**Example:**\n');
            md.appendCodeblock(fn.example, 'sql');
        }
        const group = catalog.functionByName(word)?.group;
        md.appendMarkdown(`\n[ClickHouse documentation](${functionDocsUrl(group)})`);
        return new vscode.Hover(md, range);
    }

    const schema = schemaManager.getSchema();

    // ── A table from the user's schema ──
    if (schema && config.get<boolean>('hover.showTableSchema', true)) {
        const found = schemaManager.findTable(word);
        if (found) {
            const md = new vscode.MarkdownString();
            md.appendMarkdown(`**${found.db}.${found.table.name}** — *Table*\n\n`);
            if (found.table.description) md.appendMarkdown(`${found.table.description}\n\n`);
            if (found.table.engine) md.appendMarkdown(`**Engine:** \`${found.table.engine}\`\n\n`);
            if (found.table.columns.length > 0) {
                md.appendMarkdown('| Column | Type | Description |\n|---|---|---|\n');
                for (const column of found.table.columns) {
                    md.appendMarkdown(`| ${column.name} | \`${column.type}\` | ${column.description ?? ''} |\n`);
                }
            }
            return new vscode.Hover(md, range);
        }
    }

    // ── A system table, or one of its columns ──
    const systemTable = await catalog.systemTable(word);
    if (systemTable) {
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**system.${systemTable.name}** — *system table*\n\n`);
        if (systemTable.comment) md.appendMarkdown(`${systemTable.comment}\n\n`);
        md.appendMarkdown(`**Engine:** \`${systemTable.engine}\`\n\n`);
        md.appendMarkdown(`**Columns:** ${systemTable.columns.length}`);
        return new vscode.Hover(md, range);
    }

    for (const ref of context.tables) {
        if (ref.database?.toLowerCase() !== 'system') continue;
        const table = await catalog.systemTable(ref.table);
        const column = table?.columns.find(c => c.name === word);
        if (column) {
            const md = new vscode.MarkdownString();
            md.appendMarkdown(`**${column.name}** — *column of \`system.${table!.name}\`*\n\n`);
            if (column.comment) md.appendMarkdown(`${column.comment}\n\n`);
            md.appendMarkdown(`**Type:** \`${column.type}\``);
            return new vscode.Hover(md, range);
        }
    }

    // ── A column from the user's schema, preferring the tables in scope ──
    if (schema && config.get<boolean>('hover.showColumnType', true)) {
        let matches = schemaManager.findColumnsByName(word);
        if (context.tables.length > 0) {
            const inScope = new Set(context.tables.map(t => t.table.toLowerCase()));
            const scoped = matches.filter(m => inScope.has(m.table.toLowerCase()));
            if (scoped.length > 0) matches = scoped;
        }
        if (matches.length > 0) {
            const md = new vscode.MarkdownString();
            const first = matches[0];
            md.appendMarkdown(`**${first.column.name}** — *Column*\n\n`);
            if (first.column.description) md.appendMarkdown(`${first.column.description}\n\n`);
            md.appendMarkdown(`**Type:** \`${first.column.type}\`\n\n`);
            if (first.column.defaultValue) md.appendMarkdown(`**Default:** \`${first.column.defaultValue}\`\n\n`);
            if (first.column.codec) md.appendMarkdown(`**Codec:** \`${first.column.codec}\`\n\n`);
            md.appendMarkdown(`**In:** ${matches.map(m => `\`${m.db}.${m.table}\``).join(', ')}`);
            return new vscode.Hover(md, range);
        }
    }

    // ── A data type ──
    const dataType = catalog.dataTypeByName(word);
    if (dataType) {
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**${dataType.name}** — *ClickHouse data type*\n\n`);
        if (dataType.aliasTo) md.appendMarkdown(`Alias of \`${dataType.aliasTo}\`.\n\n`);
        md.appendMarkdown(`[Data type documentation](${DOCS_BASE}/data-types)`);
        return new vscode.Hover(md, range);
    }

    return undefined;
}

export function registerHoverProvider(schemaManager: SchemaManager, catalog: Catalog): vscode.Disposable {
    return vscode.languages.registerHoverProvider(
        [{ language: 'clickhouse' }, { language: 'sql' }],
        {
            async provideHover(
                document: vscode.TextDocument,
                position: vscode.Position
            ): Promise<vscode.Hover | undefined> {
                const config = vscode.workspace.getConfiguration('clickhouse');
                if (!config.get<boolean>('hover.enabled', true)) return undefined;
                try {
                    return await buildHover(document, position, schemaManager, catalog, config);
                } catch (err) {
                    console.error('ClickHouse: hover failed', err);
                    return undefined;
                }
            },
        }
    );
}
