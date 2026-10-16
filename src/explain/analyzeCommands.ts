/**
 * Analyze: run a query for its profile and draw where the time went.
 *
 * Unlike Explain, this executes. Only a read is ever analysed — the lens offers
 * it on nothing else, and the command refuses anything else — so there is no
 * path from here to a write, whatever the profile would otherwise permit.
 */
import * as vscode from 'vscode';
import { AnalysisCache } from '../analysis';
import { ConnectionManager } from '../client/connectionManager';
import { newQueryId } from '../client/httpClient';
import { classifyStatement } from '../client/safety';
import { resolveTarget } from '../client/queryRunner';
import { parse } from '../parser/parser';
import { buildPlanGraph } from './graph';
import { collectProfile } from './profile';
import { PlanPanel } from './panel';
import { PLAN_MIME, PlanPayload } from './protocol';
import { parsePlan, summarizePlan } from '../client/explain';
import { advise } from '../advice/engine';
import { enrichFindings } from '../advice/enrich';

export function registerAnalyzeCommands(
    connections: ConnectionManager,
    analysisCache: AnalysisCache,
    panel: PlanPanel
): vscode.Disposable[] {
    /** Abandons the advice of a plan that has been replaced. */
    let adviceRun: AbortController | undefined;

    /**
     * Advice runs after the plan is on screen and is never awaited before it.
     * The drawing is what was asked for; findings are a second opinion, and a
     * second opinion that delays the first is worse than none.
     */
    async function adviseInBackground(payload: PlanPayload): Promise<void> {
        adviceRun?.abort();
        const run = new AbortController();
        adviceRun = run;

        const found = await advise(
            {
                sql: payload.sql,
                program: parse(payload.sql).program,
                graph: payload.graph,
                plan: summarizePlan(parsePlan(payload.explain)),
                summary: payload.summary,
            },
            {
                signal: run.signal,
                onFindings: findings => {
                    if (!run.signal.aborted) panel.post({ type: 'findings', findings });
                },
            }
        );

        // The lookups that cost a query happen only now, and only for findings
        // that actually want one.
        if (run.signal.aborted || found.length === 0) return;
        const client = await connections.client();
        if (!client || run.signal.aborted) return;

        const enriched = await enrichFindings(found, client, { signal: run.signal });
        if (!run.signal.aborted) panel.post({ type: 'findings', findings: enriched, replace: true });
    }

    return [
        panel,

        vscode.commands.registerCommand('clickhouse.analyzeQuery', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;

            const target = resolveTarget(editor.document, editor.selection, analysisCache);
            if (!target) {
                vscode.window.showInformationMessage('ClickHouse: nothing to analyze at the cursor.');
                return;
            }
            await analyze(target.sql);
        }),

        // A runbook cell draws its plan inline, in the cell's own output, so an
        // incident note keeps the evidence next to the step that found it.
        vscode.commands.registerCommand('clickhouse.analyzeNotebookCell', async (cell?: vscode.NotebookCell) => {
            const target = cell ?? vscode.window.activeNotebookEditor?.notebook.cellAt(
                vscode.window.activeNotebookEditor.selection.start
            );
            if (!target || target.kind !== vscode.NotebookCellKind.Code) {
                vscode.window.showInformationMessage('ClickHouse: select a query cell to analyze.');
                return;
            }

            const sql = target.document.getText().replace(/;\s*$/, '').trim();
            if (!sql || !readable(sql)) {
                vscode.window.showWarningMessage(
                    'ClickHouse: Analyze runs the cell, so it only offers to analyze a read.'
                );
                return;
            }

            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'ClickHouse: analyzing the cell' },
                async () => {
                    const built = await buildPlan(sql).catch(error =>
                        error instanceof Error ? error.message : String(error)
                    );
                    const item =
                        typeof built === 'string'
                            ? vscode.NotebookCellOutputItem.text(built, 'text/plain')
                            : vscode.NotebookCellOutputItem.json(built, PLAN_MIME);

                    // There is no edit that sets outputs alone, so the cell is
                    // rewritten as it was with the plan attached. Its metadata
                    // carries the runbook's cell markers, so it comes along.
                    const replacement = new vscode.NotebookCellData(
                        target.kind,
                        target.document.getText(),
                        target.document.languageId
                    );
                    replacement.metadata = target.metadata;
                    replacement.outputs = [new vscode.NotebookCellOutput([item])];

                    const edit = new vscode.WorkspaceEdit();
                    edit.set(target.notebook.uri, [
                        vscode.NotebookEdit.replaceCells(
                            new vscode.NotebookRange(target.index, target.index + 1),
                            [replacement]
                        ),
                    ]);
                    await vscode.workspace.applyEdit(edit);
                }
            );
        }),

        vscode.commands.registerCommand('clickhouse.analyzeStatementAt', async (uri: vscode.Uri, offset: number) => {
            const document = await vscode.workspace.openTextDocument(uri);
            const position = document.positionAt(offset);
            const target = resolveTarget(document, new vscode.Selection(position, position), analysisCache);
            if (target) await analyze(target.sql);
        }),
    ];

    /**
     * Everything between a statement and a drawing: the plan text, the run, and
     * the profile. Shared so a runbook cell produces exactly what the panel
     * does, rather than a second implementation that drifts.
     */
    async function buildPlan(sql: string): Promise<PlanPayload | string> {
        const profile = connections.activeProfileName();
        const client = await connections.client();
        if (!client || !profile) return 'No connection is selected.';

        const config = vscode.workspace.getConfiguration('clickhouse');
        const canFlushLogs = connections.activeProfile()?.allowWrite === true;

        const explained = await client.query(`EXPLAIN PLAN indexes = 1 ${sql}`, {
            readOnly: true,
            maxExecutionTime: 30,
        });
        const explain = explained.rows.map(row => String(row[0] ?? '')).join('\n');

        const collected = await collectProfile(client, sql, {
            queryId: newQueryId(),
            canFlushLogs,
            maxExecutionTime: config.get<number>('query.maxExecutionTime', 60),
        });

        if (collected.rows.length === 0) {
            return collected.timedOut
                ? 'The query ran, but system.processors_profile_log had not been written yet. ' +
                      'ClickHouse flushes it on a timer; a profile that may write can flush it at once. ' +
                      'Try again, or grant the profile write access.'
                : 'The query ran, but reported no processors. ' +
                      'Check that this user can read system.processors_profile_log.';
        }

        return {
            sql,
            profile,
            explain,
            graph: buildPlanGraph(collected.rows),
            summary: collected.summary,
            timedOut: collected.timedOut,
        };
    }

    /** Analyze only ever runs a read, whatever the profile would allow. */
    function readable(sql: string): boolean {
        const parsed = parse(sql).program.statements[0];
        return Boolean(parsed) && classifyStatement(parsed).effect === 'read';
    }

    async function analyze(statement: string): Promise<void> {
        const sql = statement.replace(/;\s*$/, '');
        if (!readable(sql)) {
            vscode.window.showWarningMessage(
                'ClickHouse: Analyze runs the query, so it only offers to analyze a read.'
            );
            return;
        }

        panel.show(`Plan — ${connections.activeProfileName() ?? 'ClickHouse'}`);
        panel.post({ type: 'status', message: 'Running the query and waiting for the profile…' });

        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Window, title: 'ClickHouse: analyzing' },
            async () => {
                try {
                    const built = await buildPlan(sql);
                    if (typeof built === 'string') {
                        panel.post({ type: 'error', message: built });
                    } else {
                        panel.showPlan(built);
                        void adviseInBackground(built).catch(error =>
                            console.error('ClickHouse: advice failed', error)
                        );
                    }
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    panel.post({ type: 'error', message: `The query failed: ${message}` });
                }
            }
        );
    }
}
