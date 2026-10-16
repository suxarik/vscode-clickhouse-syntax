/**
 * Tests for the lazy half of the advice.
 *
 * Naming the key a table is actually sorted by costs a query, so it happens
 * after the findings are already on screen — never before them.
 */
import { enrichFindings, EnrichClient } from '../advice/enrich';
import { Finding } from '../advice/types';
import { QueryResult } from '../client/types';

function answer(rows: unknown[][]): QueryResult {
    return {
        queryId: 'q',
        columns: ['database', 'name', 'sorting_key', 'partition_key'].map(name => ({ name, type: 'String' })),
        rows,
        truncated: false,
        elapsedMs: 1,
    };
}

function client(rows: unknown[][]): EnrichClient & { calls: string[] } {
    const calls: string[] = [];
    return {
        calls,
        async query(sql: string) {
            calls.push(sql);
            return answer(rows);
        },
    };
}

const pruning = (table: string): Finding => ({
    ruleId: 'no-index-pruning',
    importance: 'high',
    title: `The index on ${table} removed nothing`,
    evidence: 'granules 2104/2104, parts 2/2',
    subject: { kind: 'table', name: table },
    pending: true,
});

describe('enrichFindings', () => {
    it('names the key the table is actually sorted by', async () => {
        const server = client([['demo', 'orders', 'user_id, created_at', 'toYYYYMM(created_at)']]);
        const [finding] = await enrichFindings([pruning('demo.orders')], server);

        expect(finding.evidence).toContain('user_id, created_at');
        expect(finding.pending).toBe(false);
    });

    it('asks once for every table, not once per finding', async () => {
        const server = client([
            ['demo', 'orders', 'user_id', ''],
            ['demo', 'users', 'user_id', ''],
        ]);
        await enrichFindings([pruning('demo.orders'), pruning('demo.users')], server);

        expect(server.calls).toHaveLength(1);
    });

    it('does nothing at all when no finding is waiting on it', async () => {
        const server = client([]);
        const settled: Finding = { ...pruning('demo.orders'), pending: false };
        await enrichFindings([settled], server);

        expect(server.calls).toHaveLength(0);
    });

    it('leaves the finding usable when the lookup fails', async () => {
        const failing: EnrichClient = {
            async query() {
                throw new Error('not permitted to read system.tables');
            },
        };
        const [finding] = await enrichFindings([pruning('demo.orders')], failing);

        expect(finding.title).toContain('removed nothing');
        expect(finding.pending).toBe(false);
    });

    it('resolves a table named without its database', async () => {
        const server = client([['demo', 'orders', 'user_id', '']]);
        const [finding] = await enrichFindings([pruning('orders')], server);

        expect(finding.evidence).toContain('user_id');
    });

    it('abandons the work when a newer plan replaced it', async () => {
        const controller = new AbortController();
        controller.abort();
        const server = client([['demo', 'orders', 'user_id', '']]);

        await enrichFindings([pruning('demo.orders')], server, { signal: controller.signal });
        expect(server.calls).toHaveLength(0);
    });
});
