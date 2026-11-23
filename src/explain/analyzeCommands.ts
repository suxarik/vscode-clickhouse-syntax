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
import { ClickHouseClient, newQueryId } from '../client/httpClient';
import { classifyStatement } from '../client/safety';
import { editorParameters } from '../client/editorParameters';
import { resolveTarget } from '../client/queryRunner';
import { parse } from '../parser/parser';
import { buildPlanGraph } from './graph';
import { collectProfile } from './profile';
import { PlanPanel } from './panel';
import { PLAN_MIME, PlanPayload } from './protocol';
import { Finding } from '../advice/types';
import { parsePlan, summarizePlan } from '../client/explain';
import { advise } from '../advice/engine';
import { enrichFindings } from '../advice/enrich';
import { AdviceDiagnostics, AdviceSource } from '../advice/diagnostics';
import { fetchDistributedWork } from '../cluster/distributed';
import { distributedFindings } from '../cluster/rules';
import {
    observe,
    summariseTable,
    Observation,
    ObservationMemento,
    ObservationStore,
} from '../advice/observations';

export function registerAnalyzeCommands(
    connections: ConnectionManager,
    analysisCache: AnalysisCache,
    panel: PlanPanel,
    memento: ObservationMemento
): vscode.Disposable[] {
    /** Abandons the advice of a plan that has been replaced. */
    let adviceRun: AbortController | undefined;
    const diagnostics = new AdviceDiagnostics();
    /** Resolved once per session: the cluster this server belongs to, if any. */
    let clusterName: string | undefined | null;
    const observations = new ObservationStore(memento);

    /**
     * Advice runs after the plan is on screen and is never awaited before it.
     * The drawing is what was asked for; findings are a second opinion, and a
     * second opinion that delays the first is worse than none.
     */
    async function adviseInBackground(
        payload: PlanPayload,
        where?: { document: vscode.TextDocument; offset: number }
    ): Promise<void> {
        adviceRun?.abort();
        const run = new AbortController();
        adviceRun = run;

        const program = parse(payload.sql).program;
        const source: AdviceSource | undefined = where && {
            uri: where.document.uri,
            version: where.document.version,
            offset: where.offset,
            program,
        };

        const found = await advise(
            {
                sql: payload.sql,
                program,
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
        if (run.signal.aborted) return;

        const shards = await adviseOnShards(
            client,
            payload.queryId,
            connections.activeProfile()?.allowWrite === true,
            run.signal
        );
        if (run.signal.aborted) return;

        const all = [...enriched, ...shards];
        panel.post({ type: 'findings', findings: all, replace: true });
        void recordWhatWasSeen(payload, program, enriched);
        // Only now, so the squiggle carries the enriched wording rather than
        // the first draft of it.
        if (where && source) diagnostics.show(where.document, source, all);
    }

    return [
        panel,
        diagnostics,

        vscode.commands.registerCommand('clickhouse.adviseOnSchema', async () => {
            const tables = observations.tables();
            if (tables.length === 0) {
                vscode.window.showInformationMessage(
                    'ClickHouse: analyze a few queries first — schema advice comes from what they had in common.'
                );
                return;
            }

            const client = await connections.client();
            if (!client) {
                vscode.window.showWarningMessage('ClickHouse: no connection selected.');
                return;
            }

            const keys = new Map<string, string>();
            const columns = new Map<string, string[]>();
            try {
                const parameters = { tables: `[${tables.map(name => `'${name}'`).join(',')}]` };
                const answer = await client.query(
                    "SELECT concat(database, '.', name) AS qualified, sorting_key FROM system.tables " +
                        'WHERE concat(database, \'.\', name) IN ({tables:Array(String)})',
                    { readOnly: true, maxExecutionTime: 15, parameters }
                );
                for (const row of answer.rows) keys.set(String(row[0] ?? ''), String(row[1] ?? ''));

                // Which columns each table has, so nothing is suggested for a
                // column that lives on the other side of a join.
                const columnRows = await client.query(
                    "SELECT concat(database, '.', table) AS qualified, name FROM system.columns " +
                        'WHERE concat(database, \'.\', table) IN ({tables:Array(String)})',
                    { readOnly: true, maxExecutionTime: 15, parameters }
                );
                for (const row of columnRows.rows) {
                    const table = String(row[0] ?? '');
                    columns.set(table, [...(columns.get(table) ?? []), String(row[1] ?? '')]);
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                vscode.window.showWarningMessage(`ClickHouse: could not read the table keys — ${message}`);
                return;
            }

            const all = observations.all();
            const advice = tables
                .map(table => summariseTable(table, all, keys.get(table) ?? '', columns.get(table)))
                .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

            if (advice.length === 0) {
                vscode.window.showInformationMessage(
                    'ClickHouse: nothing to suggest — the indexes are doing their job on what has been analysed.'
                );
                return;
            }

            const content = [
                '-- ClickHouse: what several analysed queries had in common.',
                '--',
                '-- Nothing here has been applied. Read it, then run what you agree with.',
                '-- Only column names were kept to work this out: no query text, no values.',
                '',
                ...advice.map(entry => `${entry.ddl}\n\n-- ${entry.note}\n`),
            ].join('\n');

            const document = await vscode.workspace.openTextDocument({ content, language: 'clickhouse' });
            await vscode.window.showTextDocument(document, { preview: false });
        }),

        vscode.commands.registerCommand('clickhouse.forgetSchemaObservations', async () => {
            await observations.forget();
            vscode.window.showInformationMessage('ClickHouse: forgot what the analysed queries had in common.');
        }),

        vscode.commands.registerCommand('clickhouse.analyzeQuery', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;

            const target = resolveTarget(editor.document, editor.selection, analysisCache);
            if (!target) {
                vscode.window.showInformationMessage('ClickHouse: nothing to analyze at the cursor.');
                return;
            }
            await analyze(target.sql, {
                document: editor.document,
                offset: target.range ? editor.document.offsetAt(target.range.start) : 0,
            });
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
            if (target) {
                await analyze(target.sql, {
                    document,
                    offset: target.range ? document.offsetAt(target.range.start) : offset,
                });
            }
        }),
    ];

    /**
     * Everything between a statement and a drawing: the plan text, the run, and
     * the profile. Shared so a runbook cell produces exactly what the panel
     * does, rather than a second implementation that drifts.
     */
    async function buildPlan(sql: string): Promise<PlanPayload | string> {
        // The query is run once for the profile, so it needs its values first.
        const parameters = await editorParameters.resolve(sql);
        if (parameters === undefined) return 'Cancelled: no value was given for a query parameter.';

        const profile = connections.activeProfileName();
        const client = await connections.client();
        if (!client || !profile) return 'No connection is selected.';

        const config = vscode.workspace.getConfiguration('clickhouse');
        const canFlushLogs = connections.activeProfile()?.allowWrite === true;

        const explained = await client.query(`EXPLAIN PLAN indexes = 1 ${sql}`, {
            readOnly: true,
            maxExecutionTime: 30,
            parameters,
        });
        const explain = explained.rows.map(row => String(row[0] ?? '')).join('\n');

        const queryId = newQueryId();
        const collected = await collectProfile(client, sql, {
            queryId,
            canFlushLogs,
            maxExecutionTime: config.get<number>('query.maxExecutionTime', 60),
            parameters,
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
            queryId,
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

    /**
     * Keep the shape of what was seen, so a habit can be spotted later.
     *
     * Column names, a pruning fraction and a row count. Never the query, never
     * a literal, never a result.
     */
    /**
     * The cluster this server is part of, asked once.
     *
     * A single node still reports a `default` cluster containing only itself,
     * so the question is whether any cluster has more than one host.
     */
    async function clusterOf(client: { query: ClickHouseClient['query'] }): Promise<string | undefined> {
        if (clusterName !== undefined) return clusterName ?? undefined;

        clusterName = null;
        try {
            const answer = await client.query(
                'SELECT cluster FROM system.clusters GROUP BY cluster HAVING count() > 1 ' +
                    'ORDER BY count() DESC LIMIT 1',
                { readOnly: true, maxExecutionTime: 10 }
            );
            clusterName = answer.rows[0] ? String(answer.rows[0][0] ?? '') || null : null;
        } catch {
            // Not permitted to read system.clusters, which is not a problem
            // worth reporting for a feature that only adds to the picture.
        }
        return clusterName ?? undefined;
    }

    /**
     * What each shard did, when the query was distributed.
     *
     * Last of all, because it costs two more round trips and adds to a plan
     * that is already on screen. A query that ran on one node returns nothing
     * and nothing is shown.
     */
    async function adviseOnShards(
        client: ClickHouseClient,
        queryId: string,
        canFlushLogs: boolean,
        signal: AbortSignal
    ): Promise<Finding[]> {
        const cluster = await clusterOf(client);
        if (!cluster || signal.aborted) return [];

        // Each shard logged its own subquery locally, so every node has to
        // flush before any of them can be read.
        if (canFlushLogs) {
            await client
                .execute(`SYSTEM FLUSH LOGS ON CLUSTER ${cluster}`, { maxExecutionTime: 15 })
                .catch(() => undefined);
        }
        if (signal.aborted) return [];

        const work = await fetchDistributedWork(client, cluster, queryId);
        return work ? distributedFindings(work) : [];
    }

    async function recordWhatWasSeen(
        payload: PlanPayload,
        program: ReturnType<typeof parse>['program'],
        findings: Finding[]
    ): Promise<void> {
        const plan = summarizePlan(parsePlan(payload.explain));
        const seen: Observation[] = [];

        for (const finding of findings) {
            if (finding.ruleId !== 'no-index-pruning' || finding.subject?.kind !== 'table') continue;

            const index = plan.indexes.find(usage => usage.table === finding.subject?.name);
            const total = index?.granulesTotal ?? 0;
            const selected = index?.granulesSelected ?? total;

            seen.push(
                observe({
                    table: finding.subject.name,
                    prunedFraction: total > 0 ? 1 - selected / total : 0,
                    rowsRead: payload.summary?.read_rows ?? 0,
                    program,
                })
            );
        }

        await observations.record(seen);
    }

    async function analyze(
        statement: string,
        where?: { document: vscode.TextDocument; offset: number }
    ): Promise<void> {
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
                        void adviseInBackground(built, where).catch(error =>
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
