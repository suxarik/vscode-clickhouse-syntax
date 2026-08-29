/**
 * `ClickHouse: Show Performance Stats`.
 *
 * Runs the budget measurements against the real parser, binder and completion
 * builder inside the real extension host - not against a mock - and reports
 * each one against its number.
 */
import * as vscode from 'vscode';
import { AnalysisCache, analyzeText, makeColumnSource } from './analysis';
import { Catalog } from './catalog';
import { SchemaManager } from './schemaManager';
import { parse } from './parser/parser';
import { getSqlContext, isAfterDot } from './sqlContext';
import { buildCompletions } from './providers/completionProvider';
import { scopeAt, visibleCtes, visibleTables } from './parser/binder';
import { BUDGETS, formatMs, Measurement, renderReport, syntheticLines, syntheticSql, timeIt, TYPICAL_KB } from './perf';

/** Set once, at activation, by whoever measured it. */
let activationMs: number | undefined;

export function recordActivation(ms: number): void {
    activationMs = ms;
}

/**
 * Run every measurement and hand back the results.
 *
 * Separate from the command so a test can assert on the numbers rather than on
 * an output channel it cannot read.
 */
export async function measurePerformance(
    schemaManager: SchemaManager,
    catalog: Catalog,
    analysisCache: AnalysisCache
): Promise<Map<string, Measurement>> {
    const measurements = new Map<string, Measurement>();

    if (activationMs !== undefined) {
        measurements.set('activation', { id: 'activation', ms: activationMs, samples: 1 });
    }

    const columnSource = makeColumnSource(schemaManager, catalog);

    const hundredKb = syntheticSql(100 * 1024);
    measurements.set('parse', {
        ...timeIt(() => analyzeText(hundredKb, columnSource)),
        id: 'parse',
        note: `${(hundredKb.length / 1024).toFixed(0)} KB, ${parse(hundredKb).program.statements.length} statements`,
    });

    // What a keystroke costs. Measured on a large-but-real file
    // rather than the stress-test one, and reported with the rate,
    // so the 100 KB case is not hidden by the choice of size.
    const typical = `${syntheticSql(TYPICAL_KB * 1024)}\nSELECT 1;`;
    const typicalTiming = timeIt(() => analyzeText(typical, columnSource), 10);
    const rate = typicalTiming.ms / TYPICAL_KB;
    measurements.set('reparse', {
        ...typicalTiming,
        id: 'reparse',
        note:
            `A full re-analysis - there is no incremental path. ` +
            `${formatMs(rate)} per KB, so 100 KB costs about ${formatMs(rate * 100)}.`,
    });

    const document = await vscode.workspace.openTextDocument({
        language: 'clickhouse',
        content: syntheticLines(5000),
    });
    const position = new vscode.Position(6, 4);
    const config = vscode.workspace.getConfiguration('clickhouse');

    // Warm the caches the real path would also have warmed.
    await runCompletion(document, position, schemaManager, catalog, config, analysisCache);
    const started = performance.now();
    const samples = 3;
    for (let i = 0; i < samples; i++) {
        await runCompletion(document, position, schemaManager, catalog, config, analysisCache);
    }
    measurements.set('completion', {
        id: 'completion',
        ms: (performance.now() - started) / samples,
        samples,
        note: `${document.lineCount} lines`,
    });

    return measurements;
}

export function registerPerformanceCommand(
    schemaManager: SchemaManager,
    catalog: Catalog,
    analysisCache: AnalysisCache
): vscode.Disposable[] {
    return [
        // Not in the palette: it exists so the integration suite can assert on
        // the numbers rather than on an output channel it cannot read.
        vscode.commands.registerCommand('clickhouse.measurePerformance', () =>
            measurePerformance(schemaManager, catalog, analysisCache)
        ),
        vscode.commands.registerCommand('clickhouse.showPerformanceStats', async () => {
            const measurements = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Window, title: 'ClickHouse: measuring' },
                () => measurePerformance(schemaManager, catalog, analysisCache)
            );

            const channel = vscode.window.createOutputChannel('ClickHouse Performance');
            channel.clear();
            channel.appendLine(
                renderReport(measurements, [
                    'These run in this extension host, on this machine, against synthetic SQL.',
                    'They are for spotting a regression, not for comparing two computers.',
                ])
            );
            channel.show(true);
        }),
    ];
}

async function runCompletion(
    document: vscode.TextDocument,
    position: vscode.Position,
    schemaManager: SchemaManager,
    catalog: Catalog,
    config: vscode.WorkspaceConfiguration,
    analysisCache: AnalysisCache
): Promise<void> {
    const analysis = analysisCache.get(document);
    const scope = scopeAt(analysis.binding, document.offsetAt(position));
    await buildCompletions(
        getSqlContext(document, position),
        isAfterDot(document, position),
        schemaManager,
        catalog,
        config,
        visibleTables(scope),
        visibleCtes(scope).map(cte => cte.name.name)
    );
}

export { BUDGETS };
