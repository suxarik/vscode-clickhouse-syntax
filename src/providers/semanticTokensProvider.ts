/**
 * Semantic highlighting driven by the parse tree.
 *
 * A TextMate grammar cannot tell a table from a column from an alias — it only
 * sees words. The binder can, so tables, columns, aliases, CTEs and lambda
 * parameters get their own colours here.
 */
import * as vscode from 'vscode';
import { AnalysisCache } from '../analysis';
import { Catalog } from '../catalog';
import { walk } from '../parser/walk';
import { resolveName } from '../parser/binder';
import { Node } from '../parser/ast';

const TOKEN_TYPES = ['namespace', 'class', 'property', 'variable', 'function', 'parameter'] as const;
const TOKEN_MODIFIERS = ['declaration', 'defaultLibrary'] as const;

export const SEMANTIC_TOKENS_LEGEND = new vscode.SemanticTokensLegend(
    [...TOKEN_TYPES],
    [...TOKEN_MODIFIERS]
);

type TokenType = (typeof TOKEN_TYPES)[number];
type TokenModifier = (typeof TOKEN_MODIFIERS)[number];

interface RawToken {
    start: number;
    end: number;
    type: TokenType;
    modifiers: TokenModifier[];
}

export function collectSemanticTokens(
    document: vscode.TextDocument,
    analysisCache: AnalysisCache,
    catalog: Catalog
): RawToken[] {
    const analysis = analysisCache.get(document);
    const tokens: RawToken[] = [];

    const add = (
        node: { start: number; end: number } | undefined,
        type: TokenType,
        modifiers: TokenModifier[] = []
    ) => {
        if (!node || node.end <= node.start) return;
        tokens.push({ start: node.start, end: node.end, type, modifiers });
    };

    walk(analysis.program, (node: Node) => {
        switch (node.kind) {
            case 'TableRef':
                add(node.database, 'namespace');
                add(node.table, 'class', node.database?.name.toLowerCase() === 'system' ? ['defaultLibrary'] : []);
                add(node.alias, 'variable', ['declaration']);
                break;
            case 'SubquerySource':
            case 'TableFunctionSource':
                add(node.alias, 'variable', ['declaration']);
                break;
            case 'Cte':
                add(node.name, 'class', ['declaration']);
                break;
            case 'SelectItem':
                add(node.alias, 'variable', ['declaration']);
                break;
            case 'ColumnDefinition':
                add(node.name, 'property', ['declaration']);
                break;
            case 'Lambda':
                for (const param of node.params) add(param, 'parameter', ['declaration']);
                break;
            case 'FunctionCall':
                add(
                    { start: node.nameStart, end: node.nameEnd },
                    'function',
                    catalog.functionByName(node.name) ? ['defaultLibrary'] : []
                );
                break;
            case 'SettingAssignment':
                add(node.name, 'property');
                break;
            default:
                break;
        }
    });

    // Column and qualifier references need the bound scope to be classified.
    for (const reference of analysis.binding.references) {
        if (reference.kind !== 'column') continue;
        const resolution = resolveName(reference.scope, reference.name, reference.qualifier);
        const qualifierLength = reference.qualifier ? reference.qualifier.length : 0;

        if (reference.qualifier) {
            add({ start: reference.start, end: reference.start + qualifierLength }, 'variable');
            const nameStart = reference.end - reference.name.length;
            add({ start: nameStart, end: reference.end }, 'property');
            continue;
        }

        switch (resolution.kind) {
            case 'lambdaParam':
                add(reference, 'parameter');
                break;
            case 'alias':
                add(reference, 'variable');
                break;
            case 'column':
            case 'arrayJoin':
                add(reference, 'property');
                break;
            default:
                break;
        }
    }

    tokens.sort((a, b) => a.start - b.start || a.end - b.end);

    // Overlapping tokens confuse the renderer; keep the first at each position.
    const result: RawToken[] = [];
    let lastEnd = -1;
    for (const token of tokens) {
        if (token.start < lastEnd) continue;
        result.push(token);
        lastEnd = token.end;
    }
    return result;
}

export function buildSemanticTokens(
    document: vscode.TextDocument,
    analysisCache: AnalysisCache,
    catalog: Catalog
): vscode.SemanticTokens {
    const builder = new vscode.SemanticTokensBuilder(SEMANTIC_TOKENS_LEGEND);
    for (const token of collectSemanticTokens(document, analysisCache, catalog)) {
        const start = document.positionAt(token.start);
        const end = document.positionAt(token.end);
        // A semantic token cannot span lines.
        if (start.line !== end.line) continue;
        builder.push(start.line, start.character, token.end - token.start, TOKEN_TYPES.indexOf(token.type), modifierMask(token.modifiers));
    }
    return builder.build();
}

function modifierMask(modifiers: TokenModifier[]): number {
    let mask = 0;
    for (const modifier of modifiers) mask |= 1 << TOKEN_MODIFIERS.indexOf(modifier);
    return mask;
}

export function registerSemanticTokensProvider(
    analysisCache: AnalysisCache,
    catalog: Catalog
): vscode.Disposable {
    return vscode.languages.registerDocumentSemanticTokensProvider(
        [{ language: 'clickhouse' }, { language: 'sql' }],
        {
            provideDocumentSemanticTokens(document) {
                const config = vscode.workspace.getConfiguration('clickhouse');
                if (!config.get<boolean>('semanticHighlighting.enabled', true)) {
                    return new vscode.SemanticTokens(new Uint32Array(0));
                }
                try {
                    return buildSemanticTokens(document, analysisCache, catalog);
                } catch (err) {
                    console.error('ClickHouse: semantic tokens failed', err);
                    return new vscode.SemanticTokens(new Uint32Array(0));
                }
            },
        },
        SEMANTIC_TOKENS_LEGEND
    );
}
