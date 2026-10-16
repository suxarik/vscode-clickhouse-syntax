/**
 * Tests for running a query for its profile and collecting the result.
 */
import { analyzeSql, collectProfile, ProfileClient } from '../explain/profile';
import { QueryResult } from '../client/types';

function result(columns: string[], rows: unknown[][]): QueryResult {
    return {
        queryId: 'q',
        columns: columns.map(name => ({ name, type: 'String' })),
        rows,
        truncated: false,
        elapsedMs: 1,
    };
}

const PROFILE_COLUMNS = [
    'id', 'parent_ids', 'plan_step', 'plan_step_name', 'plan_step_description', 'plan_group',
    'step_uniq_id', 'name', 'elapsed_us', 'input_wait_elapsed_us', 'output_wait_elapsed_us',
    'input_rows', 'input_bytes', 'output_rows', 'output_bytes',
];

const ONE_PROCESSOR = [
    '1', [], '0', 'ReadFromMergeTree', '', 0, 'Read_1', 'MergeTreeSelect', 100, 0, 0, 0, 0, 10, 80,
];

/** Records every statement sent, and answers from a queue per table. */
function fakeClient(profileAnswers: unknown[][][]): ProfileClient & { sent: string[]; executed: string[] } {
    const sent: string[] = [];
    const executed: string[] = [];
    let profileCall = 0;
    return {
        sent,
        executed,
        async execute(sql: string) {
            executed.push(sql.trim());
            return '';
        },
        async query(sql: string) {
            sent.push(sql.trim());
            if (sql.includes('processors_profile_log')) {
                const rows = profileAnswers[Math.min(profileCall, profileAnswers.length - 1)];
                profileCall += 1;
                return result(PROFILE_COLUMNS, rows);
            }
            if (sql.includes('query_log')) {
                return result(['query_duration_ms', 'read_rows', 'read_bytes', 'result_rows', 'memory_usage', 'threads'], [[31, 1566400, 27467652, 100, 13983538, 18]]);
            }
            return result([], []);
        },
    };
}

const never = async (): Promise<void> => undefined;

describe('analyzeSql', () => {
    it('sends the rows nowhere, so no production data is fetched for a plan', () => {
        expect(analyzeSql('SELECT 1')).toBe('SELECT 1\nFORMAT Null');
    });

    it('replaces a FORMAT the query already had', () => {
        expect(analyzeSql('SELECT a FROM t FORMAT JSONEachRow')).toBe('SELECT a FROM t\nFORMAT Null');
    });

    it('drops a trailing semicolon, which cannot precede FORMAT', () => {
        expect(analyzeSql('SELECT 1;')).toBe('SELECT 1\nFORMAT Null');
    });

    it('is not fooled by the word FORMAT inside a string', () => {
        expect(analyzeSql("SELECT 'FORMAT JSON' AS s")).toBe("SELECT 'FORMAT JSON' AS s\nFORMAT Null");
    });
});

describe('collectProfile', () => {
    it('runs the query under the id it will look the profile up by', async () => {
        const client = fakeClient([[ONE_PROCESSOR]]);
        await collectProfile(client, 'SELECT 1', { queryId: 'abc', canFlushLogs: false, sleep: never });

        expect(client.sent[0]).toContain('FORMAT Null');
    });

    it('turns the profile rows into objects the graph can read', async () => {
        const client = fakeClient([[ONE_PROCESSOR]]);
        const collected = await collectProfile(client, 'SELECT 1', {
            queryId: 'abc',
            canFlushLogs: false,
            sleep: never,
        });

        expect(collected.rows[0]).toMatchObject({ step_uniq_id: 'Read_1', elapsed_us: 100, output_rows: 10 });
    });

    it('reads the wall-clock totals from the query log', async () => {
        const client = fakeClient([[ONE_PROCESSOR]]);
        const collected = await collectProfile(client, 'SELECT 1', {
            queryId: 'abc',
            canFlushLogs: false,
            sleep: never,
        });

        expect(collected.summary).toMatchObject({ query_duration_ms: 31, read_rows: 1566400, result_rows: 100, threads: 18 });
    });

    it('keeps polling until the log buffer flushes', async () => {
        // The *_log tables are written on a timer, so the first look finds nothing.
        const client = fakeClient([[], [], [ONE_PROCESSOR]]);
        const collected = await collectProfile(client, 'SELECT 1', {
            queryId: 'abc',
            canFlushLogs: false,
            sleep: never,
        });

        expect(collected.rows).toHaveLength(1);
        expect(client.sent.filter(sql => sql.includes('processors_profile_log'))).toHaveLength(3);
    });

    it('gives up rather than polling for ever', async () => {
        let clock = 0;
        const client = fakeClient([[]]);
        const collected = await collectProfile(client, 'SELECT 1', {
            queryId: 'abc',
            canFlushLogs: false,
            sleep: never,
            now: () => (clock += 4000),
            timeoutMs: 10_000,
        });

        expect(collected.rows).toHaveLength(0);
        expect(collected.timedOut).toBe(true);
    });

    it('flushes the logs first when the profile is allowed to', async () => {
        const client = fakeClient([[ONE_PROCESSOR]]);
        await collectProfile(client, 'SELECT 1', { queryId: 'abc', canFlushLogs: true, sleep: never });

        expect(client.executed).toContain('SYSTEM FLUSH LOGS');
    });

    it('sends the flush as a statement, not as something expecting rows back', async () => {
        // query() appends a FORMAT clause, which is a syntax error after
        // SYSTEM FLUSH LOGS — so the flush failed every time and the wait
        // quietly covered for it.
        const client = fakeClient([[ONE_PROCESSOR]]);
        await collectProfile(client, 'SELECT 1', { queryId: 'abc', canFlushLogs: true, sleep: never });

        expect(client.sent.some(sql => sql.includes('FLUSH LOGS'))).toBe(false);
    });

    it('does not flush on a profile that may not write', async () => {
        const client = fakeClient([[ONE_PROCESSOR]]);
        await collectProfile(client, 'SELECT 1', { queryId: 'abc', canFlushLogs: false, sleep: never });

        expect(client.executed.some(sql => sql.includes('FLUSH LOGS'))).toBe(false);
        expect(client.sent.some(sql => sql.includes('FLUSH LOGS'))).toBe(false);
    });
});
