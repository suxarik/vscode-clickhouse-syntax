/**
 * Diagnostics for ClickHouse SQL.
 *
 * Findings come from the lint rules, which read the parse tree and the bound
 * scopes rather than scanning text. Analysis is debounced and cancellable, and
 * every diagnostic carries its rule id so it can be configured, silenced with an
 * inline comment, or matched by a quick fix.
 */
import * as vscode from 'vscode';
import { SchemaManager } from '../schemaManager';
import { Catalog } from '../catalog';
import { AnalysisCache } from '../analysis';
import { lint, LintFinding, ruleDocsUrl, Severity } from '../lint/engine';

export const DIAGNOSTIC_SOURCE = 'clickhouse';

export function createDiagnosticCollection(): vscode.DiagnosticCollection {
    return vscode.languages.createDiagnosticCollection('clickhouse');
}

const SEVERITY_MAP: Record<Exclude<Severity, 'off'>, vscode.DiagnosticSeverity> = {
    error: vscode.DiagnosticSeverity.Error,
    warning: vscode.DiagnosticSeverity.Warning,
    info: vscode.DiagnosticSeverity.Information,
    hint: vscode.DiagnosticSeverity.Hint,
};

function toDiagnostic(document: vscode.TextDocument, finding: LintFinding): vscode.Diagnostic {
    const range = new vscode.Range(document.positionAt(finding.start), document.positionAt(finding.end));
    const diagnostic = new vscode.Diagnostic(range, finding.message, SEVERITY_MAP[finding.severity]);
    diagnostic.source = DIAGNOSTIC_SOURCE;
    diagnostic.code = {
        value: finding.ruleId,
        target: vscode.Uri.parse(ruleDocsUrl(finding.ruleId)),
    };
    return diagnostic;
}

/** Legacy severity toggles, expressed as rule overrides. */
function severitiesFrom(config: vscode.WorkspaceConfiguration): Record<string, string> {
    const configured = { ...config.get<Record<string, string>>('diagnostics.rules', {}) };

    if (!config.get<boolean>('diagnostics.schemaValidation', true)) {
        for (const rule of ['unknown-table', 'unknown-column', 'ambiguous-column']) {
            configured[rule] = configured[rule] ?? 'off';
        }
    }
    if (!config.get<boolean>('diagnostics.bestPractices', true)) {
        for (const rule of [
            'select-star', 'missing-final', 'final-on-plain-mergetree', 'prewhere-on-non-mergetree',
            'inefficient-not-in', 'unbounded-limit', 'or-index-inefficiency', 'cross-join',
        ]) {
            configured[rule] = configured[rule] ?? 'off';
        }
    }
    if (!config.get<boolean>('diagnostics.settingsValidation', true)) {
        for (const rule of ['unknown-setting', 'experimental-setting', 'setting-type-mismatch']) {
            configured[rule] = configured[rule] ?? 'off';
        }
    }
    if (!config.get<boolean>('diagnostics.syntaxErrors', true)) {
        configured['syntax-error'] = configured['syntax-error'] ?? 'off';
    }
    return configured;
}

export function computeDiagnostics(
    document: vscode.TextDocument,
    analysisCache: AnalysisCache,
    schemaManager: SchemaManager,
    catalog: Catalog,
    config: vscode.WorkspaceConfiguration
): vscode.Diagnostic[] {
    const analysis = analysisCache.get(document);
    const serverVersion = config.get<string>('serverVersion', 'auto');
    const findings = lint(analysis, schemaManager, catalog, {
        severities: severitiesFrom(config),
        serverVersion: serverVersion === 'auto' ? undefined : serverVersion,
    });
    return findings.map(finding => toDiagnostic(document, finding));
}

/**
 * Debounces analysis per document and drops results that a newer edit has
 * already superseded.
 */
export class DiagnosticManager implements vscode.Disposable {
    private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly versions = new Map<string, number>();

    constructor(
        private readonly collection: vscode.DiagnosticCollection,
        private readonly analysisCache: AnalysisCache,
        private readonly schemaManager: SchemaManager,
        private readonly catalog: Catalog
    ) {}

    private get debounceMs(): number {
        const value = vscode.workspace.getConfiguration('clickhouse').get<number>('diagnostics.debounceMs', 300);
        return Math.max(0, Math.min(5000, value));
    }

    schedule(document: vscode.TextDocument): void {
        const key = document.uri.toString();
        const existing = this.timers.get(key);
        if (existing) clearTimeout(existing);
        this.versions.set(key, document.version);
        this.timers.set(
            key,
            setTimeout(() => {
                this.timers.delete(key);
                this.run(document);
            }, this.debounceMs)
        );
    }

    /** Analyse straight away, skipping the debounce. */
    run(document: vscode.TextDocument): void {
        const key = document.uri.toString();
        const config = vscode.workspace.getConfiguration('clickhouse');
        if (!config.get<boolean>('diagnostics.enabled', true)) {
            this.collection.delete(document.uri);
            return;
        }
        // A newer edit landed while we were waiting — that run will supersede this one.
        const expected = this.versions.get(key);
        if (expected !== undefined && document.version !== expected) return;

        try {
            this.collection.set(
                document.uri,
                computeDiagnostics(document, this.analysisCache, this.schemaManager, this.catalog, config)
            );
        } catch (err) {
            console.error('ClickHouse: diagnostics failed', err);
            this.collection.delete(document.uri);
        }
    }

    clear(document: vscode.TextDocument): void {
        const key = document.uri.toString();
        const timer = this.timers.get(key);
        if (timer) clearTimeout(timer);
        this.timers.delete(key);
        this.versions.delete(key);
        this.analysisCache.forget(document);
        this.collection.delete(document.uri);
    }

    dispose(): void {
        for (const timer of this.timers.values()) clearTimeout(timer);
        this.timers.clear();
        this.versions.clear();
    }
}
