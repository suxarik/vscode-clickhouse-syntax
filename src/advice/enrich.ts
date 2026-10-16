/**
 * The lazy half of the advice.
 *
 * A finding like "the index removed nothing" is worth more when it can say what
 * the table is sorted by instead — but the schema does not carry a sorting key,
 * and `EXPLAIN` only names one when an index was actually used, which is
 * precisely not this case. So it costs a query, and a query may not hold up a
 * finding that is already true without it. The finding appears first and is
 * upgraded here.
 */
import { QueryResult } from '../client/types';
import { Finding } from './types';

export interface EnrichClient {
    query(
        sql: string,
        options?: { readOnly?: boolean; maxExecutionTime?: number; parameters?: Record<string, string> }
    ): Promise<QueryResult>;
}

export interface EnrichOptions {
    signal?: AbortSignal;
}

const KEYS_SQL =
    'SELECT database, name, sorting_key, partition_key FROM system.tables ' +
    "WHERE concat(database, '.', name) IN ({tables:Array(String)}) OR name IN ({tables:Array(String)})";

function tablesWanted(findings: Finding[]): string[] {
    const wanted = new Set<string>();
    for (const finding of findings) {
        if (finding.pending && finding.subject?.kind === 'table') wanted.add(finding.subject.name);
    }
    return [...wanted];
}

/** ClickHouse reads an Array(String) parameter as its own literal syntax. */
function arrayLiteral(values: string[]): string {
    return `[${values.map(value => `'${value.replace(/'/g, "\\'")}'`).join(',')}]`;
}

export async function enrichFindings(
    findings: Finding[],
    client: EnrichClient,
    options: EnrichOptions = {}
): Promise<Finding[]> {
    if (options.signal?.aborted) return findings;

    const wanted = tablesWanted(findings);
    if (wanted.length === 0) return findings;

    const keys = new Map<string, { sorting: string; partition: string }>();
    try {
        const answer = await client.query(KEYS_SQL, {
            readOnly: true,
            maxExecutionTime: 10,
            parameters: { tables: arrayLiteral(wanted) },
        });
        const column = (name: string): number => answer.columns.findIndex(c => c.name === name);
        for (const row of answer.rows) {
            const database = String(row[column('database')] ?? '');
            const name = String(row[column('name')] ?? '');
            const entry = {
                sorting: String(row[column('sorting_key')] ?? ''),
                partition: String(row[column('partition_key')] ?? ''),
            };
            keys.set(`${database}.${name}`, entry);
            keys.set(name, entry);
        }
    } catch {
        // The finding stands on its own; it simply stays as first written.
    }

    if (options.signal?.aborted) return findings;

    return findings.map(finding => {
        if (!finding.pending || finding.subject?.kind !== 'table') return finding;

        const found = keys.get(finding.subject.name);
        if (!found?.sorting) return { ...finding, pending: false };

        return {
            ...finding,
            pending: false,
            evidence: `${finding.evidence} · sorted by (${found.sorting})`,
            // Deliberately about the key rather than about the query: a join
            // condition mentions a column without narrowing it, and telling
            // someone they "do not filter on user_id" while they are joining
            // on user_id is the kind of wrong that discredits the rest.
            suggestion:
                `The key leads with ${found.sorting.split(',')[0].trim()}, and nothing in this query narrows it, ` +
                'so every granule had to be read. A skip index on the column the query does narrow, or a key ' +
                'that leads with it, would let ClickHouse skip some.',
        };
    });
}
