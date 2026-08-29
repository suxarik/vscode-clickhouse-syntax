/**
 * The ClickHouse lint rules.
 *
 * Rules only fire when the parse tree gives enough certainty: a column is never
 * reported unknown while any table in scope has unknown columns, and engine
 * advice needs a schema entry for the table.
 */
import {
    Expression,
    FunctionCall,
    SelectStatement,
    Star,
    TableRef,
} from '../parser/ast';
import { allSelects, walk } from '../parser/walk';
import { resolveName } from '../parser/binder';
import { isAvailableIn } from '../catalog/helpers';
import { LintContext, Rule } from './types';

const DEDUPLICATING_ENGINE = /(Replacing|Collapsing|VersionedCollapsing)MergeTree/i;
const MERGE_TREE_ENGINE = /MergeTree/i;

/** Aggregate functions are illegal in WHERE/PREWHERE; HAVING is where they go. */
function isAggregate(name: string, context: LintContext): boolean {
    const fn = context.catalog.functionByName(name);
    if (fn?.aggregate) return true;
    // `-If`, `-Array`, `-State` and friends are aggregate combinators.
    const base = name.replace(/(If|Array|State|Merge|OrNull|OrDefault|Resample|Distinct|ForEach|Map)+$/,'');
    return base !== name && context.catalog.functionByName(base)?.aggregate === true;
}

function containsAggregate(expression: Expression, context: LintContext): FunctionCall | undefined {
    let found: FunctionCall | undefined;
    walk(expression, node => {
        if (found) return false;
        if (node.kind === 'FunctionCall' && isAggregate(node.name, context)) {
            found = node;
            return false;
        }
        // A subquery has its own aggregation context.
        if (node.kind === 'SubqueryExpression') return false;
        return undefined;
    });
    return found;
}

/** Engine of a table reference, from the user's schema. */
function engineOf(ref: TableRef, context: LintContext): string | undefined {
    return context.schemaManager.getEngine(ref.table.name, ref.database?.name);
}

export const RULES: Rule[] = [
    {
        id: 'syntax-error',
        description: 'The statement could not be parsed.',
        defaultSeverity: 'error',
        run(context) {
            for (const diagnostic of context.analysis.parseDiagnostics) {
                context.report({
                    ruleId: 'syntax-error',
                    start: diagnostic.start,
                    end: diagnostic.end,
                    message: diagnostic.message,
                });
            }
        },
    },

    {
        id: 'unknown-table',
        description: 'A FROM or JOIN target that is not in the schema.',
        defaultSeverity: 'warning',
        run(context) {
            const { binding } = context.analysis;
            for (const scope of binding.scopes) {
                for (const table of scope.tables) {
                    if (table.kind !== 'table' || !table.table) continue;
                    // A dbt tag the manifest could not resolve names something
                    // only dbt can work out. Reporting it as missing would put
                    // a warning on every model in a project that has not been
                    // compiled yet, which teaches people to ignore warnings.
                    if (
                        table.node.kind === 'TableRef' &&
                        table.node.template &&
                        !context.schemaManager.findTable(table.table, table.database)
                    ) {
                        continue;
                    }
                    if (table.database?.toLowerCase() === 'system') {
                        if (!context.catalog.systemTablesReady) continue;
                        if (context.catalog.systemTableSync(table.table)) continue;
                        context.report({
                            ruleId: 'unknown-table',
                            start: table.node.start,
                            end: table.node.end,
                            message: `'system.${table.table}' is not a system table in ClickHouse ${context.catalog.version}`,
                        });
                        continue;
                    }
                    // With no schema loaded there is nothing to check against.
                    if (!context.schemaManager.getSchema()) continue;
                    if (context.schemaManager.findTable(table.table, table.database)) continue;
                    if (!table.database && context.catalog.systemTableSync(table.table)) continue;
                    const label = table.database ? `${table.database}.${table.table}` : table.table;
                    context.report({
                        ruleId: 'unknown-table',
                        start: table.node.start,
                        end: table.node.start + label.length,
                        message: `Table '${label}' not found in schema`,
                        data: { table: table.table, database: table.database },
                    });
                }
            }
        },
    },

    {
        id: 'unknown-column',
        description: 'A column that none of the tables in scope has.',
        defaultSeverity: 'warning',
        run(context) {
            for (const reference of context.analysis.binding.references) {
                if (reference.kind !== 'column') continue;
                const resolution = resolveName(reference.scope, reference.name, reference.qualifier);
                if (resolution.kind === 'unknown') {
                    const where = reference.qualifier
                        ? `'${reference.qualifier}'`
                        : 'any table in scope';
                    context.report({
                        ruleId: 'unknown-column',
                        start: reference.start,
                        end: reference.end,
                        message: `Column '${reference.name}' is not in ${where}`,
                        data: { column: reference.name, qualifier: reference.qualifier },
                    });
                } else if (resolution.kind === 'unknownQualifier') {
                    context.report({
                        ruleId: 'unknown-column',
                        start: reference.start,
                        end: reference.end,
                        message: `'${reference.qualifier}' is not a table or alias in scope`,
                        data: { qualifier: reference.qualifier },
                    });
                }
            }
        },
    },

    {
        id: 'ambiguous-column',
        description: 'An unqualified column that several tables in scope have.',
        defaultSeverity: 'warning',
        run(context) {
            for (const reference of context.analysis.binding.references) {
                if (reference.kind !== 'column' || reference.qualifier) continue;
                const resolution = resolveName(reference.scope, reference.name);
                if (resolution.kind !== 'column' || resolution.tables.length < 2) continue;
                const labels = resolution.tables.map(table => table.label).join(', ');
                context.report({
                    ruleId: 'ambiguous-column',
                    start: reference.start,
                    end: reference.end,
                    message: `Column '${reference.name}' is ambiguous — it exists in ${labels}`,
                    data: { column: reference.name, tables: resolution.tables.map(t => t.label) },
                });
            }
        },
    },

    {
        id: 'unknown-function',
        description: 'A function this ClickHouse version does not have.',
        defaultSeverity: 'warning',
        run(context) {
            for (const reference of context.analysis.binding.references) {
                if (reference.kind !== 'function') continue;
                const fn = context.catalog.functionByName(reference.name);
                if (!fn) {
                    // Lambdas, table functions and user-defined functions are not in the catalog.
                    context.report({
                        ruleId: 'unknown-function',
                        start: reference.start,
                        end: reference.end,
                        message: `Unknown function '${reference.name}' in ClickHouse ${context.catalog.version}`,
                        data: { function: reference.name },
                    });
                    continue;
                }
                if (!isAvailableIn(fn.since, context.serverVersion)) {
                    context.report({
                        ruleId: 'unknown-function',
                        start: reference.start,
                        end: reference.end,
                        message: `'${fn.name}' was introduced in ClickHouse ${fn.since}, newer than the configured ${context.serverVersion}`,
                        data: { function: fn.name, since: fn.since },
                    });
                }
            }
        },
    },

    {
        id: 'aggregate-in-filter',
        description: 'An aggregate function in WHERE or PREWHERE, which ClickHouse rejects.',
        defaultSeverity: 'error',
        run(context) {
            for (const select of allSelects(context.analysis.program)) {
                for (const [clause, expression] of [
                    ['WHERE', select.where],
                    ['PREWHERE', select.prewhere],
                ] as const) {
                    if (!expression) continue;
                    const call = containsAggregate(expression, context);
                    if (!call) continue;
                    context.report({
                        ruleId: 'aggregate-in-filter',
                        start: call.nameStart,
                        end: call.nameEnd,
                        message: `Aggregate function '${call.name}' cannot be used in ${clause}. Use HAVING instead.`,
                        data: { clause, function: call.name },
                    });
                }
            }
        },
    },

    {
        id: 'unknown-setting',
        description: 'A name in SETTINGS that this ClickHouse version does not have.',
        defaultSeverity: 'warning',
        run(context) {
            for (const reference of context.analysis.binding.references) {
                if (reference.kind !== 'setting') continue;
                if (context.catalog.settingByName(reference.name)) continue;
                context.report({
                    ruleId: 'unknown-setting',
                    start: reference.start,
                    end: reference.end,
                    message: `Unknown setting '${reference.name}' in ClickHouse ${context.catalog.version}`,
                    data: { setting: reference.name },
                });
            }
        },
    },

    {
        id: 'experimental-setting',
        description: 'A setting ClickHouse marks as experimental or beta.',
        defaultSeverity: 'info',
        run(context) {
            for (const reference of context.analysis.binding.references) {
                if (reference.kind !== 'setting') continue;
                const setting = context.catalog.settingByName(reference.name);
                if (!setting?.tier) continue;
                context.report({
                    ruleId: 'experimental-setting',
                    start: reference.start,
                    end: reference.end,
                    message: `'${setting.name}' is ${setting.tier.toLowerCase()} and may change or be removed.`,
                });
            }
        },
    },

    {
        id: 'setting-type-mismatch',
        description: 'A SETTINGS value that cannot fit the setting’s declared type.',
        defaultSeverity: 'warning',
        run(context) {
            walk(context.analysis.program, node => {
                if (node.kind !== 'SettingAssignment' || !node.value) return;
                const setting = context.catalog.settingByName(node.name.name);
                if (!setting) return;
                if (valueFitsType(setting.type, node.value)) return;
                context.report({
                    ruleId: 'setting-type-mismatch',
                    start: node.value.start,
                    end: node.value.end,
                    message: `'${setting.name}' expects ${setting.type}`,
                });
            });
        },
    },

    {
        id: 'select-star',
        description: 'SELECT * reads every column, including ones you do not need.',
        defaultSeverity: 'info',
        run(context) {
            for (const select of allSelects(context.analysis.program)) {
                for (const item of select.columns) {
                    if (item.expression.kind !== 'Star') continue;
                    const star = item.expression as Star;
                    if (star.qualifier || star.except) continue;
                    context.report({
                        ruleId: 'select-star',
                        start: star.start,
                        end: star.end,
                        message: 'Consider explicitly listing columns instead of SELECT *',
                    });
                }
            }
        },
    },

    {
        id: 'missing-final',
        description: 'Reading a deduplicating MergeTree table without FINAL.',
        defaultSeverity: 'info',
        run(context) {
            for (const select of allSelects(context.analysis.program)) {
                for (const source of sourcesOfSelect(select)) {
                    if (source.kind !== 'TableRef' || source.final) continue;
                    const engine = engineOf(source, context);
                    if (!engine || !DEDUPLICATING_ENGINE.test(engine)) continue;
                    context.report({
                        ruleId: 'missing-final',
                        start: source.start,
                        end: source.table.end,
                        message: `${source.table.name} uses ${engine}. Consider adding FINAL to deduplicate rows.`,
                        data: { table: source.table.name },
                    });
                }
            }
        },
    },

    {
        id: 'final-on-plain-mergetree',
        description: 'FINAL on an engine that never deduplicates only costs time.',
        defaultSeverity: 'info',
        run(context) {
            for (const select of allSelects(context.analysis.program)) {
                for (const source of sourcesOfSelect(select)) {
                    if (source.kind !== 'TableRef' || !source.final) continue;
                    const engine = engineOf(source, context);
                    if (!engine || DEDUPLICATING_ENGINE.test(engine)) continue;
                    context.report({
                        ruleId: 'final-on-plain-mergetree',
                        start: source.start,
                        end: source.end,
                        message: `${source.table.name} uses ${engine}, which never deduplicates. FINAL only adds cost here.`,
                        data: { table: source.table.name },
                    });
                }
            }
        },
    },

    {
        id: 'prewhere-on-non-mergetree',
        description: 'PREWHERE only helps MergeTree-family engines.',
        defaultSeverity: 'warning',
        run(context) {
            for (const select of allSelects(context.analysis.program)) {
                if (!select.prewhere) continue;
                const source = select.from?.source;
                if (!source || source.kind !== 'TableRef') continue;
                const engine = engineOf(source, context);
                if (!engine || MERGE_TREE_ENGINE.test(engine)) continue;
                context.report({
                    ruleId: 'prewhere-on-non-mergetree',
                    start: select.prewhere.start,
                    end: select.prewhere.end,
                    message: `PREWHERE has no effect on ${source.table.name}, which uses ${engine}.`,
                });
            }
        },
    },

    {
        id: 'inefficient-not-in',
        description: 'NOT IN against a large subquery is slow.',
        defaultSeverity: 'info',
        run(context) {
            walk(context.analysis.program, node => {
                if (node.kind !== 'Binary') return;
                if (!node.operator.includes('NOT IN')) return;
                if (node.right.kind !== 'SubqueryExpression') return;
                context.report({
                    ruleId: 'inefficient-not-in',
                    start: node.operatorStart,
                    end: node.operatorStart + node.operator.length,
                    message: 'NOT IN with a subquery can be slow. Consider LEFT JOIN / IS NULL or NOT EXISTS.',
                });
            });
        },
    },

    {
        id: 'unbounded-limit',
        description: 'LIMIT without ORDER BY returns non-deterministic rows.',
        defaultSeverity: 'info',
        run(context) {
            for (const select of allSelects(context.analysis.program)) {
                if (!select.limit || select.orderBy.length > 0) continue;
                context.report({
                    ruleId: 'unbounded-limit',
                    start: select.limit.start,
                    end: select.limit.end,
                    message: 'LIMIT without ORDER BY returns non-deterministic results.',
                });
            }
        },
    },

    {
        id: 'or-index-inefficiency',
        description: 'OR across different columns can defeat the primary index.',
        defaultSeverity: 'info',
        run(context) {
            for (const select of allSelects(context.analysis.program)) {
                const filter = select.where ?? select.prewhere;
                if (!filter) continue;
                const or = findTopLevelOr(filter);
                if (!or) continue;
                context.report({
                    ruleId: 'or-index-inefficiency',
                    start: or.operatorStart,
                    end: or.operatorStart + 2,
                    message: 'OR conditions on different columns can prevent index usage. Consider UNION ALL.',
                });
            }
        },
    },

    {
        id: 'cross-join',
        description: 'A comma or CROSS JOIN with no condition multiplies both sides.',
        defaultSeverity: 'info',
        run(context) {
            for (const select of allSelects(context.analysis.program)) {
                for (const join of select.from?.joins ?? []) {
                    if (!join.joinType.includes('CROSS')) continue;
                    context.report({
                        ruleId: 'cross-join',
                        start: join.start,
                        end: join.source.end,
                        message: 'CROSS JOIN produces every combination of rows. Add an ON condition if that is not intended.',
                    });
                }
            }
        },
    },
];

function sourcesOfSelect(select: SelectStatement) {
    const sources = [];
    if (select.from?.source) sources.push(select.from.source);
    for (const join of select.from?.joins ?? []) sources.push(join.source);
    return sources;
}

function findTopLevelOr(expression: Expression): { operatorStart: number } | undefined {
    if (expression.kind !== 'Binary') return undefined;
    if (expression.operator === 'OR') return expression;
    if (expression.operator === 'AND') {
        return findTopLevelOr(expression.left) ?? findTopLevelOr(expression.right);
    }
    return undefined;
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
const AUTO_SETTING_TYPES = new Set(['uint64auto', 'floatauto', 'boolauto']);
const STRING_SETTING_TYPES = new Set(['string', 'char', 'map']);

function valueFitsType(type: string, value: Expression): boolean {
    const normalized = type.toLowerCase();

    const literal =
        value.kind === 'NumberLiteral'
            ? { kind: 'number' as const, text: value.text }
            : value.kind === 'StringLiteral'
              ? { kind: 'string' as const, text: value.value }
              : value.kind === 'BooleanLiteral'
                ? { kind: 'word' as const, text: String(value.value) }
                : value.kind === 'Identifier'
                  ? { kind: 'word' as const, text: value.name }
                  : undefined;
    if (!literal) return true;

    if (AUTO_SETTING_TYPES.has(normalized) && literal.text.toLowerCase() === 'auto') return true;

    if (normalized === 'bool' || normalized === 'boolauto') {
        if (literal.kind === 'number') return literal.text === '0' || literal.text === '1';
        return ['true', 'false'].includes(literal.text.toLowerCase());
    }
    if (NUMERIC_SETTING_TYPES.has(normalized) || AUTO_SETTING_TYPES.has(normalized)) {
        // Sized literals such as '10G' and '500ms' are written as strings.
        return literal.kind === 'number' || /^\d/.test(literal.text);
    }
    if (STRING_SETTING_TYPES.has(normalized)) return literal.kind === 'string';
    return true;
}

export const RULES_BY_ID = new Map(RULES.map(rule => [rule.id, rule]));
