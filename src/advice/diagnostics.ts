/**
 * Findings, shown where the query says them.
 *
 * Advice comes from a query that has run, and a document can be edited the
 * moment it finishes. Positions worked out against the old text would then
 * underline the wrong words with great confidence, which is worse than showing
 * nothing — so the findings are tied to the document version they were measured
 * against, and dropped as soon as it moves on.
 */
import * as vscode from 'vscode';
import { Program } from '../parser/ast';
import { Finding } from './types';
import { locate } from './locate';

/** Marks a diagnostic as advice rather than a lint finding. */
export const ADVICE_SOURCE = 'ClickHouse Analyze';

const SEVERITY: Record<Finding['importance'], vscode.DiagnosticSeverity> = {
    // Never Error: a query that could be faster still ran.
    high: vscode.DiagnosticSeverity.Warning,
    medium: vscode.DiagnosticSeverity.Information,
    low: vscode.DiagnosticSeverity.Hint,
};

export interface AdviceSource {
    uri: vscode.Uri;
    version: number;
    /** Where the analysed statement starts, since the tree is of the statement. */
    offset: number;
    program: Program;
}

export class AdviceDiagnostics implements vscode.Disposable {
    private readonly collection = vscode.languages.createDiagnosticCollection('clickhouse-advice');
    private readonly watcher: vscode.Disposable;
    private shown?: { uri: string; version: number };

    constructor() {
        this.watcher = vscode.workspace.onDidChangeTextDocument(event => {
            if (this.shown && event.document.uri.toString() === this.shown.uri) this.clear();
        });
    }

    /** Show what could be placed; a finding about the query as a whole has no home. */
    show(document: vscode.TextDocument, source: AdviceSource, findings: Finding[]): void {
        if (document.version !== source.version) return;

        const diagnostics: vscode.Diagnostic[] = [];
        for (const finding of findings) {
            const range = locate(finding, source.program);
            if (!range) continue;

            const diagnostic = new vscode.Diagnostic(
                new vscode.Range(
                    document.positionAt(source.offset + range.start),
                    document.positionAt(source.offset + range.end)
                ),
                [finding.title, finding.evidence, finding.suggestion].filter(Boolean).join('\n'),
                SEVERITY[finding.importance]
            );
            diagnostic.source = ADVICE_SOURCE;
            diagnostic.code = finding.ruleId;
            diagnostics.push(diagnostic);
        }

        this.collection.set(document.uri, diagnostics);
        this.shown = { uri: document.uri.toString(), version: source.version };
    }

    clear(): void {
        this.collection.clear();
        this.shown = undefined;
    }

    dispose(): void {
        this.watcher.dispose();
        this.collection.dispose();
    }
}
