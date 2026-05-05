/**
 * Diagnostic provider for ClickHouse SQL with basic and advanced checks.
 */
import * as vscode from 'vscode';
import { SchemaManager } from '../schemaManager';
import { extractTableReferences, hasClause } from '../sqlContext';

export function createDiagnosticCollection(): vscode.DiagnosticCollection {
    return vscode.languages.createDiagnosticCollection('clickhouse');
}

export function updateDiagnostics(
    document: vscode.TextDocument,
    diagnosticCollection: vscode.DiagnosticCollection,
    schemaManager: SchemaManager
): void {
    const config = vscode.workspace.getConfiguration('clickhouse');
    if (!config.get<boolean>('diagnostics.enabled', true)) {
        diagnosticCollection.delete(document.uri);
        return;
    }

    const diagnostics: vscode.Diagnostic[] = [];
    const text = document.getText();
    const schema = schemaManager.getSchema();

    // ── Schema validation: unknown tables ──
    if (config.get<boolean>('diagnostics.schemaValidation', true) && schema) {
        const tableRegex = /\bFROM\s+(\w+(?:\.\w+)?)|\bJOIN\s+(\w+(?:\.\w+)?)/gi;
        let match;
        while ((match = tableRegex.exec(text)) !== null) {
            const tableRef = match[1] || match[2];
            const parts = tableRef.split('.');
            const tableName = parts.length > 1 ? parts[1] : parts[0];

            let found = false;
            for (const db of schema.databases) {
                for (const table of db.tables) {
                    if (table.name === tableName) {
                        found = true;
                        break;
                    }
                }
            }

            if (!found) {
                const startPos = document.positionAt(match.index + (match[1] ? 5 : 5)); // after "FROM " or "JOIN "
                const endPos = document.positionAt(match.index + (match[1] ? 5 : 5) + tableRef.length);
                const range = new vscode.Range(startPos, endPos);
                const diagnostic = new vscode.Diagnostic(
                    range,
                    `Table '${tableName}' not found in schema`,
                    vscode.DiagnosticSeverity.Warning
                );
                diagnostic.code = 'unknown-table';
                diagnostics.push(diagnostic);
            }
        }
    }

    // ── Best practices: SELECT * ──
    if (config.get<boolean>('diagnostics.bestPractices', true)) {
        const starRegex = /SELECT\s+\*/gi;
        let starMatch;
        while ((starMatch = starRegex.exec(text)) !== null) {
            const startPos = document.positionAt(starMatch.index);
            const endPos = document.positionAt(starMatch.index + starMatch[0].length);
            const range = new vscode.Range(startPos, endPos);
            const diagnostic = new vscode.Diagnostic(
                range,
                'Consider explicitly listing columns instead of SELECT *',
                vscode.DiagnosticSeverity.Information
            );
            diagnostic.code = 'best-practice-select-star';
            diagnostics.push(diagnostic);
        }
    }

    // ── Advanced: Missing FINAL on Replacing/Collapsing MergeTree ──
    if (config.get<boolean>('diagnostics.bestPractices', true) && schema) {
        const refs = extractTableReferences(text);
        for (const ref of refs) {
            const engine = schemaManager.getEngine(ref.table);
            if (engine && /(Replacing|Collapsing|VersionedCollapsing)MergeTree/i.test(engine)) {
                // Check if FINAL is present near this table reference
                const tableIndex = text.toLowerCase().indexOf(ref.table.toLowerCase());
                if (tableIndex >= 0) {
                    const afterTable = text.slice(tableIndex, tableIndex + 200).toLowerCase();
                    if (!afterTable.includes('final')) {
                        const startPos = document.positionAt(tableIndex);
                        const endPos = document.positionAt(tableIndex + ref.table.length);
                        const range = new vscode.Range(startPos, endPos);
                        const diagnostic = new vscode.Diagnostic(
                            range,
                            `${ref.table} uses ${engine}. Consider adding FINAL to deduplicate rows.`,
                            vscode.DiagnosticSeverity.Information
                        );
                        diagnostic.code = 'missing-final';
                        diagnostics.push(diagnostic);
                    }
                }
            }
        }
    }

    // ── Advanced: Inefficient NOT IN ──
    if (config.get<boolean>('diagnostics.bestPractices', true)) {
        const notInRegex = /\bNOT\s+IN\b/gi;
        const notInMatch = notInRegex.exec(text);
        if (notInMatch) {
            const startPos = document.positionAt(notInMatch.index);
            const endPos = document.positionAt(notInMatch.index + notInMatch[0].length);
            const range = new vscode.Range(startPos, endPos);
            const diagnostic = new vscode.Diagnostic(
                range,
                "NOT IN can be slow with large subqueries. Consider using LEFT JOIN / IS NULL or NOT EXISTS instead.",
                vscode.DiagnosticSeverity.Information
            );
            diagnostic.code = 'inefficient-not-in';
            diagnostics.push(diagnostic);
        }
    }

    // ── Advanced: Unbounded LIMIT without ORDER BY ──
    if (config.get<boolean>('diagnostics.bestPractices', true)) {
        if (/\bLIMIT\s+\d+/i.test(text) && !hasClause(text, 'ORDER BY')) {
            const limitMatch = text.match(/\bLIMIT\s+\d+/i);
            if (limitMatch) {
                const startPos = document.positionAt(limitMatch.index!);
                const endPos = document.positionAt(limitMatch.index! + limitMatch[0].length);
                const range = new vscode.Range(startPos, endPos);
                const diagnostic = new vscode.Diagnostic(
                    range,
                    'LIMIT without ORDER BY returns non-deterministic results.',
                    vscode.DiagnosticSeverity.Information
                );
                diagnostic.code = 'unbounded-limit';
                diagnostics.push(diagnostic);
            }
        }
    }

    // ── Advanced: OR on different columns (index inefficiency) ──
    if (config.get<boolean>('diagnostics.bestPractices', true)) {
        const orRegex = /\bWHERE\b[\s\S]*?\bOR\b/gi;
        let orMatch;
        while ((orMatch = orRegex.exec(text)) !== null) {
            const startPos = document.positionAt(orMatch.index + orMatch[0].indexOf('OR'));
            const endPos = document.positionAt(orMatch.index + orMatch[0].indexOf('OR') + 2);
            const range = new vscode.Range(startPos, endPos);
            const diagnostic = new vscode.Diagnostic(
                range,
                'OR conditions on different columns can prevent index usage. Consider UNION ALL if possible.',
                vscode.DiagnosticSeverity.Information
            );
            diagnostic.code = 'or-index-inefficiency';
            diagnostics.push(diagnostic);
            break; // Only flag once per document
        }
    }

    diagnosticCollection.set(document.uri, diagnostics);
}
