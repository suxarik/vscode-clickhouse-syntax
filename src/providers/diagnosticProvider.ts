/**
 * Diagnostics for ClickHouse SQL.
 *
 * Analysis is debounced and cancellable, runs per statement rather than per
 * document, and locates findings through the tokenizer so nothing fires from
 * inside a string literal or a comment.
 */
import * as vscode from 'vscode';
import { SchemaManager } from '../schemaManager';
import {
    extractTableReferences,
    extractCteNames,
    findKeywordOccurrences,
    findSelectStar,
    findSettingReferences,
    hasClause,
    splitStatements,
    TableRef,
} from '../sqlContext';
import { Catalog } from '../catalog';

export const DIAGNOSTIC_SOURCE = 'clickhouse';

export function createDiagnosticCollection(): vscode.DiagnosticCollection {
    return vscode.languages.createDiagnosticCollection('clickhouse');
}

function makeDiagnostic(
    document: vscode.TextDocument,
    start: number,
    end: number,
    message: string,
    severity: vscode.DiagnosticSeverity,
    code: string
): vscode.Diagnostic {
    const range = new vscode.Range(document.positionAt(start), document.positionAt(end));
    const diagnostic = new vscode.Diagnostic(range, message, severity);
    diagnostic.code = code;
    diagnostic.source = DIAGNOSTIC_SOURCE;
    return diagnostic;
}

/** True when a reference resolves to something other than a schema table. */
function isLocalName(ref: TableRef, ctes: Set<string>, aliases: Set<string>): boolean {
    return ctes.has(ref.table) || aliases.has(ref.table);
}

/**
 * ClickHouse setting types are semantic, not just primitives: `MaxThreads`,
 * `Milliseconds`, `NonZeroUInt64`, `BoolAuto` and a long tail of enums. Only the
 * families we can judge confidently are checked; everything else passes.
 */
const NUMERIC_SETTING_TYPES = new Set([
    'uint64', 'int64', 'int32', 'uint32', 'float', 'double', 'milliseconds',
    'seconds', 'nonzerouint64', 'maxthreads',
]);

/** Numeric settings that also accept the literal `auto`. */
const AUTO_SETTING_TYPES = new Set(['uint64auto', 'floatauto', 'boolauto']);

const STRING_SETTING_TYPES = new Set(['string', 'char', 'map']);

/** Whether a literal is plausible for a setting's declared type. */
function valueFitsType(type: string, kind: string | undefined, value: string | undefined): boolean {
    if (!kind || value === undefined) return true;
    const normalized = type.toLowerCase();
    const bare = value.replace(/^'|'$/g, '');

    if (AUTO_SETTING_TYPES.has(normalized) && bare.toLowerCase() === 'auto') return true;

    if (normalized === 'bool' || normalized === 'boolauto') {
        if (kind === 'number') return bare === '0' || bare === '1';
        return ['true', 'false'].includes(bare.toLowerCase());
    }

    if (NUMERIC_SETTING_TYPES.has(normalized) || AUTO_SETTING_TYPES.has(normalized)) {
        // Sized literals such as '10G' and '500ms' are written as strings.
        return kind === 'number' || /^\d/.test(bare);
    }

    if (STRING_SETTING_TYPES.has(normalized)) return kind === 'string';

    // Enum-valued and unrecognised types: not enough information to judge.
    return true;
}

export function computeDiagnostics(
    document: vscode.TextDocument,
    schemaManager: SchemaManager,
    config: vscode.WorkspaceConfiguration,
    catalog?: Catalog
): vscode.Diagnostic[] {
    const diagnostics: vscode.Diagnostic[] = [];
    const text = document.getText();
    const schema = schemaManager.getSchema();
    const schemaValidation = config.get<boolean>('diagnostics.schemaValidation', true);
    const bestPractices = config.get<boolean>('diagnostics.bestPractices', true);

    for (const statement of splitStatements(text)) {
        const base = statement.start;
        const body = statement.text;
        const ctes = new Set(extractCteNames(body));
        const refs = extractTableReferences(body);
        const aliases = new Set(refs.map(r => r.alias).filter((a): a is string => !!a));

        // ── Unknown tables ──
        if (schemaValidation && schema) {
            for (const ref of refs) {
                if (isLocalName(ref, ctes, aliases)) continue;
                if (schemaManager.findTable(ref.table, ref.database)) continue;
                diagnostics.push(
                    makeDiagnostic(
                        document,
                        base + ref.start,
                        base + ref.start + ref.fullRef.length,
                        `Table '${ref.fullRef}' not found in schema`,
                        vscode.DiagnosticSeverity.Warning,
                        'unknown-table'
                    )
                );
            }
        }

        // ── SETTINGS ──
        if (catalog && config.get<boolean>('diagnostics.settingsValidation', true)) {
            for (const ref of findSettingReferences(body)) {
                const setting = catalog.settingByName(ref.name);
                if (!setting) {
                    diagnostics.push(
                        makeDiagnostic(
                            document,
                            base + ref.start,
                            base + ref.end,
                            `Unknown setting '${ref.name}' (catalog: ClickHouse ${catalog.version})`,
                            vscode.DiagnosticSeverity.Warning,
                            'unknown-setting'
                        )
                    );
                    continue;
                }
                if (setting.tier) {
                    diagnostics.push(
                        makeDiagnostic(
                            document,
                            base + ref.start,
                            base + ref.end,
                            `'${setting.name}' is ${setting.tier.toLowerCase()} and may change or be removed.`,
                            vscode.DiagnosticSeverity.Information,
                            'experimental-setting'
                        )
                    );
                }
                if (
                    ref.valueStart !== undefined &&
                    ref.valueEnd !== undefined &&
                    !valueFitsType(setting.type, ref.valueKind, ref.value)
                ) {
                    diagnostics.push(
                        makeDiagnostic(
                            document,
                            base + ref.valueStart,
                            base + ref.valueEnd,
                            `'${setting.name}' expects ${setting.type}, got ${ref.value}`,
                            vscode.DiagnosticSeverity.Warning,
                            'setting-type-mismatch'
                        )
                    );
                }
            }
        }

        if (!bestPractices) continue;

        // ── SELECT * ──
        for (const hit of findSelectStar(body)) {
            diagnostics.push(
                makeDiagnostic(
                    document,
                    base + hit.start,
                    base + hit.end,
                    'Consider explicitly listing columns instead of SELECT *',
                    vscode.DiagnosticSeverity.Information,
                    'best-practice-select-star'
                )
            );
        }

        // ── Missing FINAL on a deduplicating engine ──
        if (schema) {
            const hasFinal = hasClause(body, 'FINAL');
            for (const ref of refs) {
                if (isLocalName(ref, ctes, aliases)) continue;
                const engine = schemaManager.getEngine(ref.table, ref.database);
                if (!engine || !/(Replacing|Collapsing|VersionedCollapsing)MergeTree/i.test(engine)) continue;
                if (hasFinal) continue;
                diagnostics.push(
                    makeDiagnostic(
                        document,
                        base + ref.start,
                        base + ref.start + ref.fullRef.length,
                        `${ref.fullRef} uses ${engine}. Consider adding FINAL to deduplicate rows.`,
                        vscode.DiagnosticSeverity.Information,
                        'missing-final'
                    )
                );
            }
        }

        // ── NOT IN ──
        for (const hit of findKeywordOccurrences(body, 'NOT IN')) {
            diagnostics.push(
                makeDiagnostic(
                    document,
                    base + hit.start,
                    base + hit.end,
                    'NOT IN can be slow with large subqueries. Consider LEFT JOIN / IS NULL or NOT EXISTS instead.',
                    vscode.DiagnosticSeverity.Information,
                    'inefficient-not-in'
                )
            );
        }

        // ── LIMIT without ORDER BY ──
        const limits = findKeywordOccurrences(body, 'LIMIT');
        if (limits.length > 0 && !hasClause(body, 'ORDER BY')) {
            const hit = limits[0];
            diagnostics.push(
                makeDiagnostic(
                    document,
                    base + hit.start,
                    base + hit.end,
                    'LIMIT without ORDER BY returns non-deterministic results.',
                    vscode.DiagnosticSeverity.Information,
                    'unbounded-limit'
                )
            );
        }

        // ── OR in a filter ──
        if (hasClause(body, 'WHERE')) {
            const whereAt = findKeywordOccurrences(body, 'WHERE')[0];
            const or = findKeywordOccurrences(body, 'OR').find(hit => hit.start > whereAt.start);
            if (or) {
                diagnostics.push(
                    makeDiagnostic(
                        document,
                        base + or.start,
                        base + or.end,
                        'OR conditions on different columns can prevent index usage. Consider UNION ALL if possible.',
                        vscode.DiagnosticSeverity.Information,
                        'or-index-inefficiency'
                    )
                );
            }
        }
    }

    return diagnostics;
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
        private readonly schemaManager: SchemaManager,
        private readonly catalog?: Catalog
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
                computeDiagnostics(document, this.schemaManager, config, this.catalog)
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
        this.collection.delete(document.uri);
    }

    dispose(): void {
        for (const timer of this.timers.values()) clearTimeout(timer);
        this.timers.clear();
        this.versions.clear();
    }
}
