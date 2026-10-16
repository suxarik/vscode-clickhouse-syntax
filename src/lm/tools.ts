/**
 * The language model tool surface.
 *
 * An agent gets the same catalog, schema and connection the editor uses, and
 * one rule stricter than any profile carries: it may only read. A profile with
 * `allowWrite` lets a person write after a confirmation they can see. Nothing
 * an agent sends is seen before it runs, so nothing an agent sends may write —
 * not even on a profile that would permit it from the editor.
 */
import * as vscode from 'vscode';
import { parse } from '../parser/parser';
import { ConnectionManager } from '../client/connectionManager';
import { classifyStatement, combinedEffect } from '../client/safety';
import { QueryResult } from '../client/types';

export type AgentQueryVerdict = { ok: true } | { ok: false; reason: string };

/** Decide whether a query the model wrote may be sent at all. */
export function guardAgentQuery(sql: string): AgentQueryVerdict {
    const statements = parse(sql).program.statements;
    if (statements.length === 0) {
        return { ok: false, reason: 'There is no statement to run.' };
    }

    const summaries = statements.map(classifyStatement);
    if (combinedEffect(summaries) === 'read') return { ok: true };

    const refused = summaries.filter(summary => summary.effect !== 'read').map(summary => summary.label);
    return {
        ok: false,
        reason:
            `This tool is read-only, so ${refused.join(', ')} will not be sent. ` +
            'Run it from the editor, where a person confirms it first.',
    };
}

/** Longest cell a model needs to see; past this the value is noise. */
const MAX_CELL = 200;

function renderCell(value: unknown): string {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'object') return JSON.stringify(value);
    const text = String(value);
    return text.length > MAX_CELL ? `${text.slice(0, MAX_CELL - 1)}…` : text;
}

/** A result as tab-separated text, with the column types kept. */
export function formatResultForModel(result: QueryResult): string {
    const header = result.columns.map(column => `${column.name} ${column.type}`).join('\t');
    if (result.rows.length === 0) return `${header}\n\n(no rows)`;

    const body = result.rows.map(row => row.map(renderCell).join('\t')).join('\n');
    const notes = [`${result.rows.length} rows`];
    if (result.truncated) notes.push('truncated at the row cap');
    return `${header}\n${body}\n\n(${notes.join(', ')})`;
}

// ── The tools themselves ─────────────────────────────────────────────────────

/** Rows an agent gets by default. It may ask for more, up to the hard cap. */
const DEFAULT_AGENT_ROWS = 200;
const MAX_AGENT_ROWS = 2000;

const NO_CONNECTION =
    'No ClickHouse connection is active. Ask the user to run "ClickHouse: Add Connection", ' +
    'or to pick a profile from the status bar.';

function textResult(text: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}

function failureText(error: unknown): string {
    return `The query failed: ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * Run a read-only query. Both of the editor's checks apply: the statement is
 * classified from the parse tree, and `readonly` goes with the request so the
 * server refuses a write too.
 */
async function readOnlyQuery(
    connections: ConnectionManager,
    sql: string,
    token: vscode.CancellationToken,
    options: { maxRows?: number; parameters?: Record<string, string> } = {}
): Promise<vscode.LanguageModelToolResult> {
    const client = await connections.client();
    if (!client) return textResult(NO_CONNECTION);

    const controller = new AbortController();
    const cancel = token.onCancellationRequested(() => controller.abort());
    try {
        const result = await client.query(sql, {
            readOnly: true,
            maxRows: options.maxRows ?? DEFAULT_AGENT_ROWS,
            parameters: options.parameters,
            signal: controller.signal,
        });
        return textResult(formatResultForModel(result));
    } catch (error) {
        return textResult(failureText(error));
    } finally {
        cancel.dispose();
    }
}

interface RunQueryInput {
    query: string;
    maxRows?: number;
}

class RunQueryTool implements vscode.LanguageModelTool<RunQueryInput> {
    constructor(private readonly connections: ConnectionManager) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<RunQueryInput>,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const sql = (options.input.query ?? '').trim();
        const verdict = guardAgentQuery(sql);
        if (!verdict.ok) return textResult(verdict.reason);

        const asked = options.input.maxRows ?? DEFAULT_AGENT_ROWS;
        const maxRows = Math.max(1, Math.min(asked, MAX_AGENT_ROWS));
        return readOnlyQuery(this.connections, sql, token, { maxRows });
    }
}

interface ListTablesInput {
    database?: string;
}

const LIST_TABLES_SQL = `
SELECT database, name, engine, total_rows
FROM system.tables
WHERE database NOT IN ('INFORMATION_SCHEMA', 'information_schema')
  AND ({database:String} = '' OR database = {database:String})
ORDER BY database, name
`;

class ListTablesTool implements vscode.LanguageModelTool<ListTablesInput> {
    constructor(private readonly connections: ConnectionManager) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ListTablesInput>,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        return readOnlyQuery(this.connections, LIST_TABLES_SQL, token, {
            maxRows: MAX_AGENT_ROWS,
            parameters: { database: options.input.database ?? '' },
        });
    }
}

interface DescribeTableInput {
    table: string;
    database?: string;
}

const DESCRIBE_TABLE_SQL = `
SELECT name, type, default_expression, comment
FROM system.columns
WHERE table = {table:String}
  AND ({database:String} = '' OR database = {database:String})
ORDER BY position
`;

class DescribeTableTool implements vscode.LanguageModelTool<DescribeTableInput> {
    constructor(private readonly connections: ConnectionManager) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<DescribeTableInput>,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const table = (options.input.table ?? '').trim();
        if (!table) return textResult('Name the table to describe.');

        return readOnlyQuery(this.connections, DESCRIBE_TABLE_SQL, token, {
            maxRows: MAX_AGENT_ROWS,
            parameters: { table, database: options.input.database ?? '' },
        });
    }
}

/** Register every tool. Each name matches a `languageModelTools` contribution. */
export function registerLanguageModelTools(connections: ConnectionManager): vscode.Disposable[] {
    return [
        vscode.lm.registerTool('clickhouse_run_query', new RunQueryTool(connections)),
        vscode.lm.registerTool('clickhouse_list_tables', new ListTablesTool(connections)),
        vscode.lm.registerTool('clickhouse_describe_table', new DescribeTableTool(connections)),
    ];
}
