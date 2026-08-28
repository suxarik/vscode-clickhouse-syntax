/**
 * Outline, folding and smart-select, all derived from the parse tree.
 */
import * as vscode from 'vscode';
import { AnalysisCache } from '../analysis';
import { Node, SelectStatement, Statement } from '../parser/ast';
import { nodePathAt } from '../parser/walk';
import { tokenize, TokenKind } from '../lexer';

// ── Document symbols ─────────────────────────────────────────────────────────

function range(document: vscode.TextDocument, start: number, end: number): vscode.Range {
    return new vscode.Range(document.positionAt(start), document.positionAt(Math.max(start, end)));
}

function symbol(
    document: vscode.TextDocument,
    name: string,
    detail: string,
    kind: vscode.SymbolKind,
    node: { start: number; end: number },
    selection?: { start: number; end: number }
): vscode.DocumentSymbol {
    const full = range(document, node.start, node.end);
    const selectionRange = selection ? range(document, selection.start, selection.end) : full;
    // VS Code requires the selection range to sit inside the full range.
    const safeSelection = full.contains(selectionRange) ? selectionRange : full;
    return new vscode.DocumentSymbol(name, detail, kind, full, safeSelection);
}

function tableLabel(ref: { database?: { name: string }; table: { name: string } } | undefined): string {
    if (!ref) return '?';
    return ref.database ? `${ref.database.name}.${ref.table.name}` : ref.table.name;
}

function describeSelect(select: SelectStatement): string {
    const from = select.from?.source;
    if (!from) return '';
    if (from.kind === 'TableRef') return `from ${tableLabel(from)}`;
    if (from.kind === 'TableFunctionSource') return `from ${from.call.name}()`;
    return 'from subquery';
}

function selectSymbols(document: vscode.TextDocument, select: SelectStatement): vscode.DocumentSymbol[] {
    const children: vscode.DocumentSymbol[] = [];
    for (const cte of select.ctes) {
        // The detail says where the CTE reads from; nested CTEs become children.
        const detail = cte.select ? describeSelect(cte.select) || 'CTE' : 'CTE';
        const node = symbol(document, cte.name.name, detail, vscode.SymbolKind.Namespace, cte, cte.name);
        if (cte.select) node.children = selectSymbols(document, cte.select);
        children.push(node);
    }
    return children;
}

export function documentSymbols(
    document: vscode.TextDocument,
    analysisCache: AnalysisCache
): vscode.DocumentSymbol[] {
    const { program } = analysisCache.get(document);
    const symbols: vscode.DocumentSymbol[] = [];

    for (const statement of program.statements) {
        symbols.push(statementSymbol(document, statement));
    }
    return symbols;
}

function statementSymbol(document: vscode.TextDocument, statement: Statement): vscode.DocumentSymbol {
    switch (statement.kind) {
        case 'SelectStatement': {
            const node = symbol(
                document,
                'SELECT',
                describeSelect(statement),
                vscode.SymbolKind.Function,
                statement
            );
            node.children = selectSymbols(document, statement);
            return node;
        }
        case 'InsertStatement':
            return symbol(
                document,
                `INSERT INTO ${tableLabel(statement.table)}`,
                statement.select ? 'from SELECT' : `${statement.valuesCount ?? 0} row(s)`,
                vscode.SymbolKind.Function,
                statement
            );
        case 'CreateTableStatement': {
            const node = symbol(
                document,
                `TABLE ${tableLabel(statement.table)}`,
                statement.engine ?? '',
                vscode.SymbolKind.Struct,
                statement,
                statement.table
            );
            node.children = statement.columns.map(column =>
                symbol(document, column.name.name, column.typeText, vscode.SymbolKind.Field, column, column.name)
            );
            return node;
        }
        case 'CreateViewStatement':
            return symbol(
                document,
                `${statement.materialized ? 'MATERIALIZED VIEW' : 'VIEW'} ${tableLabel(statement.view)}`,
                statement.to ? `to ${tableLabel(statement.to)}` : '',
                vscode.SymbolKind.Interface,
                statement,
                statement.view
            );
        case 'AlterTableStatement':
            return symbol(
                document,
                `ALTER TABLE ${tableLabel(statement.table)}`,
                statement.actions.join(', ').slice(0, 60),
                vscode.SymbolKind.Event,
                statement,
                statement.table
            );
        case 'DropStatement':
            return symbol(
                document,
                `${statement.what} ${tableLabel(statement.target)}`,
                '',
                vscode.SymbolKind.Event,
                statement,
                statement.target
            );
        default:
            return symbol(document, statement.lead, '', vscode.SymbolKind.Event, statement);
    }
}

// ── Folding ──────────────────────────────────────────────────────────────────

export function foldingRanges(document: vscode.TextDocument, analysisCache: AnalysisCache): vscode.FoldingRange[] {
    const { program, text } = analysisCache.get(document);
    const ranges: vscode.FoldingRange[] = [];
    const seen = new Set<string>();

    const add = (start: number, end: number, kind?: vscode.FoldingRangeKind) => {
        const startLine = document.positionAt(start).line;
        const endLine = document.positionAt(end).line;
        if (endLine <= startLine) return;
        const key = `${startLine}:${endLine}`;
        if (seen.has(key)) return;
        seen.add(key);
        ranges.push(new vscode.FoldingRange(startLine, endLine, kind));
    };

    for (const statement of program.statements) add(statement.start, statement.end);

    // Parenthesised blocks: subqueries, column lists, long argument lists.
    const stack: number[] = [];
    for (const token of tokenize(text)) {
        if (token.kind === TokenKind.Punct && token.text === '(') stack.push(token.start);
        else if (token.kind === TokenKind.Punct && token.text === ')') {
            const open = stack.pop();
            if (open !== undefined) add(open, token.end);
        }
    }

    // Runs of line comments, and block comments.
    let commentStart: number | undefined;
    let commentEnd = 0;
    let previousLine = -2;
    for (const token of tokenize(text)) {
        if (token.kind === TokenKind.BlockComment) {
            add(token.start, token.end, vscode.FoldingRangeKind.Comment);
            continue;
        }
        if (token.kind === TokenKind.LineComment) {
            const line = document.positionAt(token.start).line;
            if (commentStart === undefined || line !== previousLine + 1) {
                if (commentStart !== undefined) add(commentStart, commentEnd, vscode.FoldingRangeKind.Comment);
                commentStart = token.start;
            }
            commentEnd = token.end;
            previousLine = line;
        }
    }
    if (commentStart !== undefined) add(commentStart, commentEnd, vscode.FoldingRangeKind.Comment);

    return ranges;
}

// ── Selection ranges ─────────────────────────────────────────────────────────

export function selectionRanges(
    document: vscode.TextDocument,
    positions: readonly vscode.Position[],
    analysisCache: AnalysisCache
): vscode.SelectionRange[] {
    const { program } = analysisCache.get(document);

    return positions.map(position => {
        const offset = document.offsetAt(position);
        const path = nodePathAt(program, offset);
        // Outermost first, so each range is built as the parent of the next.
        let current: vscode.SelectionRange | undefined;
        for (const node of path as Node[]) {
            const nodeRange = range(document, node.start, node.end);
            if (current && current.range.isEqual(nodeRange)) continue;
            current = new vscode.SelectionRange(nodeRange, current);
        }
        return current ?? new vscode.SelectionRange(new vscode.Range(position, position));
    });
}

// ── Registration ─────────────────────────────────────────────────────────────

const SELECTOR = [{ language: 'clickhouse' }, { language: 'sql' }];

export function registerStructureProviders(analysisCache: AnalysisCache): vscode.Disposable[] {
    return [
        vscode.languages.registerDocumentSymbolProvider(SELECTOR, {
            provideDocumentSymbols(document) {
                try {
                    return documentSymbols(document, analysisCache);
                } catch (err) {
                    console.error('ClickHouse: document symbols failed', err);
                    return [];
                }
            },
        }),
        vscode.languages.registerFoldingRangeProvider(SELECTOR, {
            provideFoldingRanges(document) {
                try {
                    return foldingRanges(document, analysisCache);
                } catch (err) {
                    console.error('ClickHouse: folding ranges failed', err);
                    return [];
                }
            },
        }),
        vscode.languages.registerSelectionRangeProvider(SELECTOR, {
            provideSelectionRanges(document, positions) {
                try {
                    return selectionRanges(document, positions, analysisCache);
                } catch (err) {
                    console.error('ClickHouse: selection ranges failed', err);
                    return [];
                }
            },
        }),
    ];
}
