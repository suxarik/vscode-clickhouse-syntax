/**
 * Inlay hints showing the type of each projected column.
 *
 * Only columns that resolve to a known table are annotated — a hint that might
 * be wrong is worse than no hint.
 */
import * as vscode from 'vscode';
import { AnalysisCache } from '../analysis';
import { SchemaManager } from '../schemaManager';
import { Catalog } from '../catalog';
import { allSelects } from '../parser/walk';
import { BoundTable, resolveName, scopeAt } from '../parser/binder';
import { Expression } from '../parser/ast';

/** Name a select-list expression refers to, when it is a plain column. */
function columnNameOf(expression: Expression): { name: string; qualifier?: string } | undefined {
    if (expression.kind === 'Identifier') return { name: expression.name };
    if (expression.kind === 'Qualified') {
        const parts = expression.parts;
        return { name: parts[parts.length - 1].name, qualifier: parts[parts.length - 2]?.name };
    }
    return undefined;
}

function typeOfColumn(
    table: BoundTable,
    column: string,
    schemaManager: SchemaManager,
    catalog: Catalog
): string | undefined {
    if (!table.table) return undefined;
    if (table.database?.toLowerCase() === 'system') {
        return catalog.systemTableSync(table.table)?.columns.find(c => c.name === column)?.type;
    }
    const found = schemaManager.findColumn(table.table, column, table.database);
    if (found) return found.type;
    return catalog.systemTableSync(table.table)?.columns.find(c => c.name === column)?.type;
}

export function computeInlayHints(
    document: vscode.TextDocument,
    range: vscode.Range,
    analysisCache: AnalysisCache,
    schemaManager: SchemaManager,
    catalog: Catalog
): vscode.InlayHint[] {
    const analysis = analysisCache.get(document);
    const from = document.offsetAt(range.start);
    const to = document.offsetAt(range.end);
    const hints: vscode.InlayHint[] = [];

    for (const select of allSelects(analysis.program)) {
        for (const item of select.columns) {
            if (item.end < from || item.start > to) continue;

            const reference = columnNameOf(item.expression);
            if (!reference) continue;

            const scope = scopeAt(analysis.binding, item.expression.start);
            const resolution = resolveName(scope, reference.name, reference.qualifier);
            if (resolution.kind !== 'column' || resolution.tables.length !== 1) continue;

            const type = typeOfColumn(resolution.tables[0], reference.name, schemaManager, catalog);
            if (!type) continue;

            const hint = new vscode.InlayHint(
                document.positionAt(item.expression.end),
                `: ${type}`,
                vscode.InlayHintKind.Type
            );
            hint.paddingLeft = false;
            hints.push(hint);
        }
    }

    return hints;
}

export function registerInlayHintsProvider(
    analysisCache: AnalysisCache,
    schemaManager: SchemaManager,
    catalog: Catalog
): vscode.Disposable {
    return vscode.languages.registerInlayHintsProvider([{ language: 'clickhouse' }, { language: 'sql' }], {
        provideInlayHints(document, range) {
            const config = vscode.workspace.getConfiguration('clickhouse');
            if (!config.get<boolean>('inlayHints.columnTypes', true)) return [];
            try {
                return computeInlayHints(document, range, analysisCache, schemaManager, catalog);
            } catch (err) {
                console.error('ClickHouse: inlay hints failed', err);
                return [];
            }
        },
    });
}
