/**
 * Code actions for ClickHouse SQL.
 *
 * Quick fixes attach to the diagnostic that motivated them, refactorings only
 * appear when the cursor is actually on something they can rewrite, and every
 * action carries a `WorkspaceEdit` so applying it is atomic and undoable in one
 * step.
 */
import * as vscode from 'vscode';
import { SchemaManager } from '../schemaManager';
import { DIAGNOSTIC_SOURCE } from './diagnosticProvider';
import {
    caseToMultiIf,
    expandSelectStar,
    findIndexHintTarget,
    findPrewhereCandidate,
    findSelectStarTarget,
    moveToPrewhere,
    TextEdit,
} from '../refactors';

function toWorkspaceEdit(document: vscode.TextDocument, edit: TextEdit): vscode.WorkspaceEdit {
    const workspaceEdit = new vscode.WorkspaceEdit();
    workspaceEdit.replace(
        document.uri,
        new vscode.Range(document.positionAt(edit.start), document.positionAt(edit.end)),
        edit.newText
    );
    return workspaceEdit;
}

function ourDiagnostics(context: vscode.CodeActionContext, code: string): vscode.Diagnostic[] {
    return context.diagnostics.filter(d => d.source === DIAGNOSTIC_SOURCE && d.code === code);
}

export function computeCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
    schemaManager: SchemaManager,
    config: vscode.WorkspaceConfiguration
): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    const text = document.getText();
    const offset = document.offsetAt(range.start);

    const quickFixes = config.get<boolean>('codeActions.quickFixes', true);
    const refactorings = config.get<boolean>('codeActions.refactorings', true);
    const transformations = config.get<boolean>('codeActions.transformations', true);

    // ── Quick fix: expand SELECT * ──
    if (quickFixes) {
        for (const diagnostic of ourDiagnostics(context, 'best-practice-select-star')) {
            const target = findSelectStarTarget(text, document.offsetAt(diagnostic.range.start));
            if (!target?.table) continue;
            const found = schemaManager.findTable(target.table.table, target.table.database);
            if (!found || found.table.columns.length === 0) continue;

            const edit = expandSelectStar(
                text,
                document.offsetAt(diagnostic.range.start),
                found.table.columns.map(c => c.name)
            );
            if (!edit) continue;

            const action = new vscode.CodeAction(
                `Expand SELECT * to ${found.table.columns.length} columns of ${found.table.name}`,
                vscode.CodeActionKind.QuickFix
            );
            action.diagnostics = [diagnostic];
            action.edit = toWorkspaceEdit(document, edit);
            action.isPreferred = true;
            actions.push(action);
        }
    }

    // ── Quick fix: add FINAL ──
    if (quickFixes) {
        for (const diagnostic of ourDiagnostics(context, 'missing-final')) {
            const tableEnd = document.offsetAt(diagnostic.range.end);
            const action = new vscode.CodeAction(
                `Add FINAL after ${document.getText(diagnostic.range)}`,
                vscode.CodeActionKind.QuickFix
            );
            action.diagnostics = [diagnostic];
            action.edit = toWorkspaceEdit(document, { start: tableEnd, end: tableEnd, newText: ' FINAL' });
            action.isPreferred = true;
            actions.push(action);
        }
    }

    // ── Transformation: CASE → multiIf ──
    if (transformations) {
        const edit = caseToMultiIf(text, offset);
        if (edit) {
            const action = new vscode.CodeAction('Convert CASE to multiIf', vscode.CodeActionKind.RefactorRewrite);
            action.edit = toWorkspaceEdit(document, edit);
            actions.push(action);
        }
    }

    // ── Refactoring: move a filter into PREWHERE ──
    if (refactorings) {
        const candidate = findPrewhereCandidate(text, offset);
        if (candidate) {
            const edit = moveToPrewhere(text, offset);
            if (edit) {
                const label = candidate.text.length > 40 ? `${candidate.text.slice(0, 37)}…` : candidate.text;
                const action = new vscode.CodeAction(
                    `Move "${label}" into PREWHERE`,
                    vscode.CodeActionKind.RefactorRewrite
                );
                action.edit = toWorkspaceEdit(document, edit);
                actions.push(action);
            }
        }
    }

    // ── Refactoring: wrap an equality filter in indexHint ──
    if (refactorings) {
        const edit = findIndexHintTarget(text, offset);
        if (edit) {
            const action = new vscode.CodeAction('Wrap filter in indexHint()', vscode.CodeActionKind.RefactorRewrite);
            action.edit = toWorkspaceEdit(document, edit);
            actions.push(action);
        }
    }

    return actions;
}

export function registerCodeActionProvider(schemaManager: SchemaManager): vscode.Disposable {
    return vscode.languages.registerCodeActionsProvider(
        [{ language: 'clickhouse' }, { language: 'sql' }],
        {
            provideCodeActions(
                document: vscode.TextDocument,
                range: vscode.Range | vscode.Selection,
                context: vscode.CodeActionContext
            ): vscode.CodeAction[] {
                const config = vscode.workspace.getConfiguration('clickhouse');
                if (!config.get<boolean>('codeActions.enabled', true)) return [];
                try {
                    return computeCodeActions(document, range, context, schemaManager, config);
                } catch (err) {
                    console.error('ClickHouse: code actions failed', err);
                    return [];
                }
            },
        },
        {
            providedCodeActionKinds: [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.RefactorRewrite],
        }
    );
}
