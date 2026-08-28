/**
 * Go to definition, find references and rename.
 *
 * These work on the names a query defines for itself — CTEs, table aliases,
 * select-list aliases and lambda parameters — where the parse tree gives an
 * exact answer. Tables and columns instead jump to their entry in the schema
 * file, which is where they are actually defined.
 */
import * as vscode from 'vscode';
import { AnalysisCache } from '../analysis';
import { SchemaManager } from '../schemaManager';
import { Identifier, Node, SelectStatement, Statement } from '../parser/ast';
import { nodePathAt, statementAt, walk } from '../parser/walk';
import { resolveName, scopeAt } from '../parser/binder';

export type LocalSymbolKind = 'cte' | 'tableAlias' | 'lambdaParam' | 'selectAlias';

export interface Occurrence {
    start: number;
    end: number;
}

export interface LocalSymbol {
    kind: LocalSymbolKind;
    name: string;
    declaration: Occurrence;
    /** Every occurrence, including the declaration. */
    occurrences: Occurrence[];
}

interface Declaration {
    kind: LocalSymbolKind;
    name: string;
    identifier: Identifier;
    /** The node whose subtree the name is visible in. */
    owner: Node;
}

function collectDeclarations(statement: Statement): Declaration[] {
    const declarations: Declaration[] = [];

    walk(statement, node => {
        switch (node.kind) {
            case 'Cte':
                declarations.push({ kind: 'cte', name: node.name.name, identifier: node.name, owner: statement });
                break;
            case 'TableRef':
            case 'SubquerySource':
            case 'TableFunctionSource':
                if (node.alias) {
                    declarations.push({
                        kind: 'tableAlias',
                        name: node.alias.name,
                        identifier: node.alias,
                        owner: statement,
                    });
                }
                break;
            case 'SelectItem':
                if (node.alias) {
                    declarations.push({
                        kind: 'selectAlias',
                        name: node.alias.name,
                        identifier: node.alias,
                        owner: statement,
                    });
                }
                break;
            case 'Lambda':
                for (const param of node.params) {
                    declarations.push({ kind: 'lambdaParam', name: param.name, identifier: param, owner: node });
                }
                break;
            default:
                break;
        }
    });

    return declarations;
}

/** Occurrences of a declared name within the subtree it is visible in. */
function occurrencesOf(declaration: Declaration): Occurrence[] {
    const lower = declaration.name.toLowerCase();
    const occurrences: Occurrence[] = [
        { start: declaration.identifier.start, end: declaration.identifier.end },
    ];

    walk(declaration.owner, node => {
        switch (node.kind) {
            case 'Identifier':
                if (node === declaration.identifier) return;
                if (node.name.toLowerCase() !== lower) return;
                // A CTE is referenced as a table name; the others as bare identifiers.
                occurrences.push({ start: node.start, end: node.end });
                break;
            case 'Qualified': {
                // Only the qualifier position can name a table alias.
                const head = node.parts[0];
                if (declaration.kind === 'tableAlias' && head.name.toLowerCase() === lower) {
                    occurrences.push({ start: head.start, end: head.end });
                }
                break;
            }
            case 'Star':
                if (declaration.kind === 'tableAlias' && node.qualifier?.name.toLowerCase() === lower) {
                    occurrences.push({ start: node.qualifier.start, end: node.qualifier.end });
                }
                break;
            default:
                break;
        }
    });

    // De-duplicate: a TableRef's own identifier can be visited twice.
    const seen = new Set<string>();
    return occurrences.filter(occurrence => {
        const key = `${occurrence.start}:${occurrence.end}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/** The query-local symbol under `offset`, if there is one. */
export function localSymbolAt(
    analysisCache: AnalysisCache,
    document: vscode.TextDocument,
    offset: number
): LocalSymbol | undefined {
    const { program } = analysisCache.get(document);
    const statement = statementAt(program, offset);
    if (!statement) return undefined;

    const declarations = collectDeclarations(statement);
    if (declarations.length === 0) return undefined;

    // Innermost declaration first, so a lambda parameter beats an outer alias.
    const ordered = [...declarations].sort((a, b) => b.owner.start - a.owner.start);

    for (const declaration of ordered) {
        const occurrences = occurrencesOf(declaration);
        if (occurrences.some(occurrence => offset >= occurrence.start && offset <= occurrence.end)) {
            return {
                kind: declaration.kind,
                name: declaration.name,
                declaration: { start: declaration.identifier.start, end: declaration.identifier.end },
                occurrences,
            };
        }
    }
    return undefined;
}

// ── Schema-file definitions ──────────────────────────────────────────────────

/** Offset of `"name": "<value>"` in a schema document, or -1. */
function findSchemaEntry(text: string, value: string): number {
    const pattern = new RegExp(`"name"\\s*:\\s*"${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`);
    return text.search(pattern);
}

async function schemaLocation(
    schemaManager: SchemaManager,
    name: string
): Promise<vscode.Location | undefined> {
    for (const file of schemaManager.getLoadedFiles()) {
        try {
            const uri = vscode.Uri.file(file);
            const schemaDocument = await vscode.workspace.openTextDocument(uri);
            const offset = findSchemaEntry(schemaDocument.getText(), name);
            if (offset < 0) continue;
            const position = schemaDocument.positionAt(offset);
            return new vscode.Location(uri, new vscode.Range(position, position));
        } catch {
            // Unreadable schema file; try the next one.
        }
    }
    return undefined;
}

// ── Providers ────────────────────────────────────────────────────────────────

const SELECTOR = [{ language: 'clickhouse' }, { language: 'sql' }];

function toRange(document: vscode.TextDocument, occurrence: Occurrence): vscode.Range {
    return new vscode.Range(document.positionAt(occurrence.start), document.positionAt(occurrence.end));
}

/** The name under the cursor, used for schema lookups. */
function identifierAt(analysisCache: AnalysisCache, document: vscode.TextDocument, offset: number): Identifier | undefined {
    const { program } = analysisCache.get(document);
    const path = nodePathAt(program, offset);
    for (let i = path.length - 1; i >= 0; i--) {
        const node = path[i];
        if (node.kind === 'Identifier') return node;
    }
    return undefined;
}

export function registerNavigationProviders(
    analysisCache: AnalysisCache,
    schemaManager: SchemaManager
): vscode.Disposable[] {
    return [
        vscode.languages.registerDefinitionProvider(SELECTOR, {
            async provideDefinition(document, position) {
                try {
                    const offset = document.offsetAt(position);
                    const symbol = localSymbolAt(analysisCache, document, offset);
                    if (symbol) {
                        return new vscode.Location(document.uri, toRange(document, symbol.declaration));
                    }
                    // Otherwise look the name up in the schema files.
                    const identifier = identifierAt(analysisCache, document, offset);
                    if (!identifier) return undefined;
                    return await schemaLocation(schemaManager, identifier.name);
                } catch (err) {
                    console.error('ClickHouse: definition lookup failed', err);
                    return undefined;
                }
            },
        }),

        vscode.languages.registerReferenceProvider(SELECTOR, {
            provideReferences(document, position, context) {
                try {
                    const symbol = localSymbolAt(analysisCache, document, document.offsetAt(position));
                    if (!symbol) return [];
                    const occurrences = context.includeDeclaration
                        ? symbol.occurrences
                        : symbol.occurrences.filter(
                              occurrence => occurrence.start !== symbol.declaration.start
                          );
                    return occurrences.map(
                        occurrence => new vscode.Location(document.uri, toRange(document, occurrence))
                    );
                } catch (err) {
                    console.error('ClickHouse: reference lookup failed', err);
                    return [];
                }
            },
        }),

        vscode.languages.registerRenameProvider(SELECTOR, {
            prepareRename(document, position) {
                const symbol = localSymbolAt(analysisCache, document, document.offsetAt(position));
                if (!symbol) {
                    throw new Error('Only CTEs, aliases and lambda parameters can be renamed here.');
                }
                return { range: toRange(document, symbol.declaration), placeholder: symbol.name };
            },
            provideRenameEdits(document, position, newName) {
                const symbol = localSymbolAt(analysisCache, document, document.offsetAt(position));
                if (!symbol) return undefined;
                if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(newName)) {
                    throw new Error(`'${newName}' is not a valid ClickHouse identifier.`);
                }
                const edit = new vscode.WorkspaceEdit();
                for (const occurrence of symbol.occurrences) {
                    edit.replace(document.uri, toRange(document, occurrence), newName);
                }
                return edit;
            },
        }),

        vscode.languages.registerDocumentHighlightProvider(SELECTOR, {
            provideDocumentHighlights(document, position) {
                const symbol = localSymbolAt(analysisCache, document, document.offsetAt(position));
                if (!symbol) return [];
                return symbol.occurrences.map(
                    occurrence =>
                        new vscode.DocumentHighlight(
                            toRange(document, occurrence),
                            occurrence.start === symbol.declaration.start
                                ? vscode.DocumentHighlightKind.Write
                                : vscode.DocumentHighlightKind.Read
                        )
                );
            },
        }),
    ];
}

/** Exported for tests. */
export { scopeAt, resolveName };
export type { SelectStatement };
