/**
 * Putting a finding back where it came from.
 *
 * `processors_profile_log` has never heard of the text — a measurement knows a
 * step took 84% of the CPU, not where the query says so. But a finding knows
 * what it is about, and the parse tree knows where that is, so the two can be
 * joined without the measurements ever carrying a position.
 *
 * Going through the tree rather than searching the text is what keeps
 * `SELECT 'uniqExact'` from being underlined as a call.
 */
import { Program } from '../parser/ast';
import { walk } from '../parser/walk';
import { Finding } from './types';

export interface SourceRange {
    start: number;
    end: number;
}

/** `demo.orders` and `orders` should both match a table called either. */
function tableMatches(wanted: string, database: string | undefined, table: string): boolean {
    const target = wanted.toLowerCase();
    const qualified = database ? `${database}.${table}`.toLowerCase() : table.toLowerCase();
    return qualified === target || table.toLowerCase() === target.split('.').pop();
}

export function locate(finding: Finding, program: Program): SourceRange | undefined {
    const subject = finding.subject;
    if (!subject) return undefined;

    let found: SourceRange | undefined;
    walk(program, node => {
        if (found) return;

        if (subject.kind === 'function' && node.kind === 'FunctionCall') {
            if (node.name.toLowerCase() === subject.name.toLowerCase()) {
                found = { start: node.nameStart, end: node.nameEnd };
            }
            return;
        }

        if (subject.kind === 'table' && node.kind === 'TableRef') {
            if (tableMatches(subject.name, node.database?.name, node.table.name)) {
                found = { start: node.database?.start ?? node.table.start, end: node.table.end };
            }
            return;
        }

        if (subject.kind === 'column' && node.kind === 'Identifier') {
            if (node.name.toLowerCase() === subject.name.toLowerCase()) {
                found = { start: node.start, end: node.end };
            }
        }
    });

    return found;
}
