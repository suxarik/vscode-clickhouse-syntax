/**
 * The lint rule contract.
 *
 * Every finding carries a rule id, so it can be given a severity in settings,
 * silenced with an inline comment, and linked to its documentation.
 */
import { DocumentAnalysis } from '../analysis';
import { SchemaManager } from '../schemaManager';
import { Catalog } from '../catalog';

export type Severity = 'off' | 'hint' | 'info' | 'warning' | 'error';

export interface Finding {
    ruleId: string;
    start: number;
    end: number;
    message: string;
    /** Extra data carried through to code actions. */
    data?: Record<string, unknown>;
}

export interface LintContext {
    analysis: DocumentAnalysis;
    schemaManager: SchemaManager;
    catalog: Catalog;
    /** Effective ClickHouse version, or undefined when unset. */
    serverVersion?: string;
    report(finding: Finding): void;
    /** Whether a rule is worth running at all. */
    enabled(ruleId: string): boolean;
}

export interface Rule {
    id: string;
    /** One line, shown in the rules reference and in settings. */
    description: string;
    defaultSeverity: Severity;
    run(context: LintContext): void;
}
