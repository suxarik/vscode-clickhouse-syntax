/**
 * Tests for code actions.
 */
import * as vscode from 'vscode';
import { computeCodeActions } from '../providers/codeActionProvider';
import { computeDiagnostics } from '../providers/diagnosticProvider';
import { SchemaManager } from '../schemaManager';
import { makeSchemaManager, makeConfig, docAt, editsOf } from './helpers';

let schemaManager: SchemaManager;

beforeAll(async () => {
    schemaManager = await makeSchemaManager();
});

/** Code actions offered at the `|` marker, with real diagnostics in context. */
function actionsAt(sql: string, overrides: Record<string, unknown> = {}) {
    const { document, position } = docAt(sql);
    const config = makeConfig(overrides);
    const diagnostics = computeDiagnostics(document, schemaManager, config);
    const range = new vscode.Range(position, position);
    const context = {
        diagnostics: diagnostics.filter(
            d =>
                document.offsetAt(d.range.start) <= document.offsetAt(position) &&
                document.offsetAt(position) <= document.offsetAt(d.range.end)
        ),
        only: undefined,
        triggerKind: 1,
    } as unknown as vscode.CodeActionContext;
    return computeCodeActions(document, range, context, schemaManager, config);
}

/** All diagnostics, not just those under the cursor. */
function actionsWithAllDiagnostics(sql: string) {
    const { document, position } = docAt(sql);
    const config = makeConfig();
    const diagnostics = computeDiagnostics(document, schemaManager, config);
    const context = { diagnostics, only: undefined, triggerKind: 1 } as unknown as vscode.CodeActionContext;
    return computeCodeActions(document, new vscode.Range(position, position), context, schemaManager, config);
}

describe('quick fixes', () => {
    it('expands SELECT * for a known table', () => {
        const actions = actionsWithAllDiagnostics('SELECT |* FROM events');
        const action = actions.find(a => a.title.startsWith('Expand SELECT *'));
        expect(action).toBeDefined();
        expect(editsOf(action!.edit)[0].newText).toBe('event_id, event_time, user_id');
        expect(action!.diagnostics).toHaveLength(1);
    });

    it('does not offer expansion for a table function', () => {
        const actions = actionsWithAllDiagnostics('SELECT |* FROM numbers(10)');
        expect(actions.find(a => a.title.startsWith('Expand SELECT *'))).toBeUndefined();
    });

    it('offers FINAL for a ReplacingMergeTree table', () => {
        const actions = actionsWithAllDiagnostics('SELECT user_id FROM us|ers');
        const action = actions.find(a => a.title.startsWith('Add FINAL'));
        expect(action).toBeDefined();
        expect(editsOf(action!.edit)[0].newText).toBe(' FINAL');
    });

    it('offers nothing without a matching diagnostic', () => {
        const { document, position } = docAt('SELECT |* FROM events');
        const context = { diagnostics: [], only: undefined, triggerKind: 1 } as unknown as vscode.CodeActionContext;
        const actions = computeCodeActions(
            document,
            new vscode.Range(position, position),
            context,
            schemaManager,
            makeConfig()
        );
        expect(actions.find(a => a.title.startsWith('Expand SELECT *'))).toBeUndefined();
    });
});

describe('refactorings', () => {
    it('offers CASE to multiIf only on a CASE', () => {
        expect(actionsAt("SELECT CASE WHEN a THEN 1 ELSE 2 |END FROM events").map(a => a.title)).toContain(
            'Convert CASE to multiIf'
        );
        expect(actionsAt('SELECT event_id| FROM events').map(a => a.title)).not.toContain('Convert CASE to multiIf');
    });

    it('offers PREWHERE only where the rewrite is valid', () => {
        const titles = actionsAt('SELECT event_id FROM events WHERE |event_time > now() AND user_id = 1').map(
            a => a.title
        );
        expect(titles.some(t => t.startsWith('Move "'))).toBe(true);

        // A single-term WHERE would be left empty, so nothing is offered.
        const single = actionsAt('SELECT event_id FROM events WHERE |user_id = 1').map(a => a.title);
        expect(single.some(t => t.startsWith('Move "'))).toBe(false);
    });

    it('produces a PREWHERE rewrite that is still valid SQL', () => {
        const action = actionsAt(
            'SELECT event_id FROM events WHERE |event_time > now() AND user_id = 1'
        ).find(a => a.title.startsWith('Move "'));
        expect(editsOf(action!.edit)[0].newText).toBe('PREWHERE event_time > now() WHERE user_id = 1');
    });

    it('offers indexHint only on an equality filter', () => {
        expect(
            actionsAt('SELECT event_id FROM events WHERE user|_id = 1').map(a => a.title)
        ).toContain('Wrap filter in indexHint()');
        expect(
            actionsAt('SELECT event_id FROM events WHERE user|_id > 1').map(a => a.title)
        ).not.toContain('Wrap filter in indexHint()');
    });

    it('honours the feature toggles', () => {
        expect(
            actionsAt("SELECT CASE WHEN a THEN 1 |END FROM events", { 'codeActions.transformations': false }).map(
                a => a.title
            )
        ).not.toContain('Convert CASE to multiIf');
        expect(
            actionsAt('SELECT event_id FROM events WHERE user|_id = 1 AND a = 2', {
                'codeActions.refactorings': false,
            })
        ).toHaveLength(0);
    });
});

describe('edits', () => {
    it('always carries a workspace edit rather than a command', () => {
        for (const action of actionsWithAllDiagnostics('SELECT |* FROM events')) {
            expect(action.edit).toBeDefined();
            expect(action.command).toBeUndefined();
        }
    });
});
