/**
 * Runs the lint rules and applies severity configuration and inline disables.
 *
 * Inline control comments, matching the shape people already know from other
 * linters:
 *
 *   -- ch-lint-disable-next-line unknown-column
 *   -- ch-lint-disable-line select-star
 *   -- ch-lint-disable unknown-table, missing-final
 *   -- ch-lint-enable unknown-table
 *
 * With no rule names the directive applies to every rule.
 */
import { tokenize, TokenKind } from '../lexer';
import { DocumentAnalysis } from '../analysis';
import { SchemaManager } from '../schemaManager';
import { Catalog } from '../catalog';
import { RULES, RULES_BY_ID } from './rules';
import { Finding, LintContext, Severity } from './types';

export { RULES, RULES_BY_ID };
export * from './types';

export interface LintOptions {
    /** Severity overrides by rule id, from `clickhouse.diagnostics.rules`. */
    severities?: Record<string, string>;
    /** Rules to skip entirely, regardless of severity. */
    disabled?: Set<string>;
    serverVersion?: string;
}

export interface LintFinding extends Finding {
    severity: Exclude<Severity, 'off'>;
}

const SEVERITIES = new Set<Severity>(['off', 'hint', 'info', 'warning', 'error']);

function normalizeSeverity(value: string | undefined): Severity | undefined {
    if (!value) return undefined;
    const lower = value.toLowerCase() as Severity;
    return SEVERITIES.has(lower) ? lower : undefined;
}

// ── Inline directives ────────────────────────────────────────────────────────

interface Directive {
    action: 'disable' | 'enable' | 'disable-line' | 'disable-next-line';
    rules: string[];
    line: number;
}

const DIRECTIVE = /ch-lint-(disable-next-line|disable-line|disable|enable)\b\s*(.*)$/i;

function lineStarts(text: string): number[] {
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\n') starts.push(i + 1);
    }
    return starts;
}

function lineOf(starts: number[], offset: number): number {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= offset) lo = mid;
        else hi = mid - 1;
    }
    return lo;
}

function collectDirectives(text: string, starts: number[]): Directive[] {
    const directives: Directive[] = [];
    for (const token of tokenize(text)) {
        if (token.kind !== TokenKind.LineComment && token.kind !== TokenKind.BlockComment) continue;
        const match = DIRECTIVE.exec(token.text);
        if (!match) continue;
        const rules = match[2]
            .replace(/\*\/\s*$/, '')
            .split(/[,\s]+/)
            .map(rule => rule.trim())
            .filter(Boolean);
        directives.push({
            action: match[1].toLowerCase() as Directive['action'],
            rules,
            line: lineOf(starts, token.start),
        });
    }
    return directives;
}

/** Decides whether a finding on a given line is silenced. */
class DisableMap {
    private readonly ranges: Array<{ rule: string; from: number; to: number }> = [];

    constructor(directives: Directive[], lineCount: number) {
        const open = new Map<string, number>();

        for (const directive of directives) {
            const rules = directive.rules.length > 0 ? directive.rules : ['*'];
            for (const rule of rules) {
                switch (directive.action) {
                    case 'disable-line':
                        this.ranges.push({ rule, from: directive.line, to: directive.line });
                        break;
                    case 'disable-next-line':
                        this.ranges.push({ rule, from: directive.line + 1, to: directive.line + 1 });
                        break;
                    case 'disable':
                        if (!open.has(rule)) open.set(rule, directive.line);
                        break;
                    case 'enable': {
                        const from = open.get(rule);
                        if (from !== undefined) {
                            this.ranges.push({ rule, from, to: directive.line });
                            open.delete(rule);
                        }
                        break;
                    }
                }
            }
        }

        for (const [rule, from] of open) {
            this.ranges.push({ rule, from, to: lineCount });
        }
    }

    silenced(ruleId: string, line: number): boolean {
        return this.ranges.some(
            range => (range.rule === '*' || range.rule === ruleId) && line >= range.from && line <= range.to
        );
    }
}

// ── Runner ───────────────────────────────────────────────────────────────────

export function lint(
    analysis: DocumentAnalysis,
    schemaManager: SchemaManager,
    catalog: Catalog,
    options: LintOptions = {}
): LintFinding[] {
    const severityFor = (ruleId: string): Severity => {
        const override = normalizeSeverity(options.severities?.[ruleId]);
        if (override) return override;
        return RULES_BY_ID.get(ruleId)?.defaultSeverity ?? 'info';
    };

    const enabled = (ruleId: string): boolean => {
        if (options.disabled?.has(ruleId)) return false;
        return severityFor(ruleId) !== 'off';
    };

    const findings: Finding[] = [];
    const context: LintContext = {
        analysis,
        schemaManager,
        catalog,
        serverVersion: options.serverVersion,
        report: finding => findings.push(finding),
        enabled,
    };

    for (const rule of RULES) {
        if (!enabled(rule.id)) continue;
        try {
            rule.run(context);
        } catch (err) {
            console.error(`ClickHouse: lint rule '${rule.id}' failed`, err);
        }
    }

    const starts = lineStarts(analysis.text);
    const disables = new DisableMap(collectDirectives(analysis.text, starts), starts.length);

    const result: LintFinding[] = [];
    for (const finding of findings) {
        const line = lineOf(starts, finding.start);
        if (disables.silenced(finding.ruleId, line)) continue;
        const severity = severityFor(finding.ruleId);
        if (severity === 'off') continue;
        result.push({ ...finding, severity });
    }
    return result;
}

/** Documentation anchor for a rule, used in diagnostic links. */
export function ruleDocsUrl(ruleId: string): string {
    return `https://github.com/suxarik/vscode-clickhouse-syntax/blob/master/docs/rules.md#${ruleId}`;
}
