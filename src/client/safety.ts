/**
 * Classifying what a statement will do to the server.
 *
 * This is the client half of the safety model: the parse tree tells us whether a
 * statement reads, writes or destroys, which decides whether it runs at all on a
 * read-only profile and whether it needs confirmation. The server half is a
 * `readonly` setting sent with every request on a profile that has not opted
 * into writes — neither half is trusted on its own.
 */
import { Statement } from '../parser/ast';

export type StatementEffect = 'read' | 'write' | 'destructive';

export interface StatementSummary {
    effect: StatementEffect;
    /** Short label for a confirmation prompt, e.g. `DROP TABLE events`. */
    label: string;
    /** Fully qualified target, when the statement names one. */
    target?: string;
}

/** Leading keywords of statements the parser does not model, by effect. */
const DESTRUCTIVE_LEAD = [
    'DROP', 'TRUNCATE', 'DETACH', 'SYSTEM', 'KILL', 'RENAME', 'EXCHANGE',
    'REVOKE', 'OPTIMIZE', 'RESTORE',
];

const WRITE_LEAD = [
    'INSERT', 'CREATE', 'ALTER', 'ATTACH', 'SET', 'GRANT', 'USE', 'BACKUP',
];

function qualify(ref: { database?: { name: string }; table: { name: string } } | undefined): string | undefined {
    if (!ref) return undefined;
    return ref.database ? `${ref.database.name}.${ref.table.name}` : ref.table.name;
}

/**
 * `ALTER … DELETE` and `ALTER … DROP` mutate data; other ALTERs change metadata.
 */
function alterEffect(actions: string[]): StatementEffect {
    for (const action of actions) {
        const head = action.trim().toUpperCase();
        if (head.startsWith('DELETE') || head.startsWith('DROP') || head.startsWith('CLEAR')) {
            return 'destructive';
        }
    }
    return 'write';
}

export function classifyStatement(statement: Statement): StatementSummary {
    switch (statement.kind) {
        case 'SelectStatement':
            return { effect: 'read', label: 'SELECT' };

        case 'InsertStatement': {
            const target = qualify(statement.table);
            return { effect: 'write', label: `INSERT INTO ${target ?? '?'}`, target };
        }

        case 'CreateTableStatement': {
            const target = qualify(statement.table);
            return { effect: 'write', label: `CREATE TABLE ${target ?? '?'}`, target };
        }

        case 'CreateViewStatement': {
            const target = qualify(statement.view);
            const what = statement.materialized ? 'CREATE MATERIALIZED VIEW' : 'CREATE VIEW';
            return { effect: 'write', label: `${what} ${target ?? '?'}`, target };
        }

        case 'AlterTableStatement': {
            const target = qualify(statement.table);
            const effect = alterEffect(statement.actions);
            const first = statement.actions[0]?.split(/\s+/).slice(0, 2).join(' ') ?? '';
            return { effect, label: `ALTER TABLE ${target ?? '?'} ${first}`.trim(), target };
        }

        case 'DropStatement': {
            const target = qualify(statement.target);
            return { effect: 'destructive', label: `${statement.what} ${target ?? '?'}`.trim(), target };
        }

        default: {
            // Statements the parser records but does not model.
            const lead = statement.lead;
            const head = lead.split(/\s+/)[0] ?? '';
            if (DESTRUCTIVE_LEAD.includes(head)) return { effect: 'destructive', label: lead };
            if (WRITE_LEAD.includes(head)) return { effect: 'write', label: lead };
            // EXPLAIN, DESCRIBE, SHOW, EXISTS, CHECK and anything unrecognised.
            return { effect: 'read', label: lead };
        }
    }
}

/** The strongest effect across a batch of statements. */
export function combinedEffect(summaries: StatementSummary[]): StatementEffect {
    if (summaries.some(s => s.effect === 'destructive')) return 'destructive';
    if (summaries.some(s => s.effect === 'write')) return 'write';
    return 'read';
}

export interface GateInput {
    summaries: StatementSummary[];
    /** The profile permits writes. */
    allowWrite: boolean;
    /** The profile is marked protected, so writes need typed confirmation. */
    isProtected: boolean;
    profileName: string;
}

export type GateDecision =
    | { action: 'run' }
    | { action: 'confirm'; message: string; confirmLabel: string }
    | { action: 'confirmTyped'; message: string; expected: string }
    | { action: 'refuse'; message: string };

/**
 * Decide what has to happen before a batch runs.
 *
 * Read-only is the default, so anything that is not a read on a profile without
 * `allowWrite` is refused outright rather than confirmed — a prompt people can
 * click through is not a safety boundary.
 */
export function gate(input: GateInput): GateDecision {
    const effect = combinedEffect(input.summaries);
    if (effect === 'read') return { action: 'run' };

    const labels = input.summaries
        .filter(summary => summary.effect !== 'read')
        .map(summary => summary.label);
    const what = labels.length === 1 ? labels[0] : `${labels.length} statements (${labels[0]}, …)`;

    if (!input.allowWrite) {
        return {
            action: 'refuse',
            message:
                `'${input.profileName}' is read-only, so ${what} will not be sent. ` +
                `Set "allowWrite": true on the profile to permit writes.`,
        };
    }

    if (input.isProtected) {
        return {
            action: 'confirmTyped',
            message: `'${input.profileName}' is protected. Type the profile name to run ${what}.`,
            expected: input.profileName,
        };
    }

    if (effect === 'destructive') {
        return {
            action: 'confirm',
            message: `Run ${what} on '${input.profileName}'? This cannot be undone.`,
            confirmLabel: 'Run',
        };
    }

    return { action: 'confirm', message: `Run ${what} on '${input.profileName}'?`, confirmLabel: 'Run' };
}
