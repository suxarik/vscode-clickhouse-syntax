/**
 * Per-document analysis: parse, bind, and cache.
 *
 * Everything downstream — diagnostics, completion, symbols, semantic tokens —
 * reads the same `DocumentAnalysis`, so a document is parsed once per revision
 * rather than once per feature.
 */
import * as vscode from 'vscode';
import { Program, ParseDiagnostic } from './parser/ast';
import { parse } from './parser/parser';
import { bind, BindResult, ColumnSource } from './parser/binder';
import { SchemaManager } from './schemaManager';
import { Catalog } from './catalog';

export interface DocumentAnalysis {
    text: string;
    version: number;
    program: Program;
    parseDiagnostics: ParseDiagnostic[];
    binding: BindResult;
}

/**
 * Columns from the user's schema, falling back to the bundled `system` catalog.
 */
export function makeColumnSource(schemaManager: SchemaManager, catalog: Catalog): ColumnSource {
    return {
        columnsOf(table: string, database?: string): string[] | undefined {
            if (database?.toLowerCase() === 'system') {
                return catalog.systemTableSync(table)?.columns.map(column => column.name);
            }
            const found = schemaManager.findTable(table, database);
            if (found) return found.table.columns.map(column => column.name);
            // An unqualified name may still be a system table.
            if (!database) return catalog.systemTableSync(table)?.columns.map(column => column.name);
            return undefined;
        },
    };
}

export function analyzeText(text: string, columnSource: ColumnSource): Omit<DocumentAnalysis, 'version'> {
    const { program, diagnostics } = parse(text);
    return { text, program, parseDiagnostics: diagnostics, binding: bind(program, columnSource) };
}

/**
 * Caches one analysis per document revision. The cache is keyed by URI and
 * invalidated by version, and also cleared when the schema reloads, since that
 * changes which columns are known.
 */
export class AnalysisCache implements vscode.Disposable {
    private readonly entries = new Map<string, DocumentAnalysis>();
    private columnSource: ColumnSource;

    constructor(private readonly schemaManager: SchemaManager, private readonly catalog: Catalog) {
        this.columnSource = makeColumnSource(schemaManager, catalog);
    }

    get(document: vscode.TextDocument): DocumentAnalysis {
        const key = document.uri.toString();
        const cached = this.entries.get(key);
        if (cached && cached.version === document.version) return cached;

        const text = document.getText();
        const analysis: DocumentAnalysis = {
            version: document.version,
            ...analyzeText(text, this.columnSource),
        };
        this.entries.set(key, analysis);
        return analysis;
    }

    /** Drop cached analyses; call when the schema or catalog changes. */
    invalidate(): void {
        this.columnSource = makeColumnSource(this.schemaManager, this.catalog);
        this.entries.clear();
    }

    forget(document: vscode.TextDocument): void {
        this.entries.delete(document.uri.toString());
    }

    dispose(): void {
        this.entries.clear();
    }
}
