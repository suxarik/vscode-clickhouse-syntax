/**
 * Tests for advice about a table rather than a query.
 *
 * This is the only part that reasons across runs, so it is the only part that
 * remembers anything — which makes what it remembers the thing to get right.
 */
import {
    filteredColumns,
    observe,
    summariseTable,
    Observation,
    ObservationStore,
} from '../advice/observations';
import { parse } from '../parser/parser';

const programOf = (sql: string) => parse(sql).program;

describe('filteredColumns', () => {
    it('finds the columns a WHERE clause constrains', () => {
        expect(filteredColumns(programOf("SELECT a FROM t WHERE status = 'paid' AND user_id > 5"))).toEqual(
            expect.arrayContaining(['status', 'user_id'])
        );
    });

    it('includes PREWHERE, which is a filter by another name', () => {
        expect(filteredColumns(programOf("SELECT a FROM t PREWHERE country = 'DE'"))).toContain('country');
    });

    it('leaves out what is only selected or grouped', () => {
        const columns = filteredColumns(programOf('SELECT revenue FROM t WHERE status = 1 GROUP BY device'));
        expect(columns).toContain('status');
        expect(columns).not.toContain('revenue');
        expect(columns).not.toContain('device');
    });

    it('leaves out a join key, which names a column without narrowing it', () => {
        const columns = filteredColumns(
            programOf("SELECT a FROM o INNER JOIN u ON u.user_id = o.user_id WHERE o.status = 'paid'")
        );
        expect(columns).toContain('status');
        expect(columns).not.toContain('user_id');
    });

    it('reports a column once however often it is mentioned', () => {
        const columns = filteredColumns(programOf('SELECT a FROM t WHERE x = 1 AND x < 9 AND x != 4'));
        expect(columns.filter(name => name === 'x')).toHaveLength(1);
    });
});

describe('observe', () => {
    it('records the shape of a query and never the query', () => {
        const record = observe({
            table: 'demo.orders',
            prunedFraction: 0,
            rowsRead: 2_300_000,
            program: programOf("SELECT a FROM demo.orders WHERE status = 'paid-and-secret'"),
        });

        const serialised = JSON.stringify(record);
        expect(serialised).toContain('status');
        // The value is the part that could carry anything at all.
        expect(serialised).not.toContain('paid-and-secret');
        expect(serialised).not.toContain('SELECT');
    });

    it('timestamps what it keeps, so old observations can be dropped', () => {
        const record = observe({
            table: 'demo.orders',
            prunedFraction: 0,
            rowsRead: 1,
            program: programOf('SELECT a FROM demo.orders WHERE x = 1'),
        });
        expect(record.at).toBeGreaterThan(0);
    });
});

describe('summariseTable', () => {
    const seen = (columns: string[], pruned: number): Observation => ({
        at: Date.now(),
        table: 'demo.orders',
        prunedFraction: pruned,
        rowsRead: 1_000_000,
        filteredColumns: columns,
    });

    it('says nothing from a single query, which proves nothing', () => {
        expect(summariseTable('demo.orders', [seen(['status'], 0)], 'user_id, created_at')).toBeUndefined();
    });

    it('suggests the column that several queries filtered on and never pruned', () => {
        const advice = summariseTable(
            'demo.orders',
            [seen(['status'], 0), seen(['status'], 0), seen(['status', 'amount'], 0)],
            'user_id, created_at'
        );

        expect(advice?.column).toBe('status');
        expect(advice?.queries).toBe(3);
        expect(advice?.ddl).toContain('ADD INDEX');
        expect(advice?.ddl).toContain('status');
    });

    it('stays quiet when the index is already doing its job', () => {
        expect(
            summariseTable('demo.orders', [seen(['status'], 0.9), seen(['status'], 0.95)], 'status, user_id')
        ).toBeUndefined();
    });

    it('does not suggest a column the key already leads with', () => {
        expect(
            summariseTable('demo.orders', [seen(['user_id'], 0), seen(['user_id'], 0)], 'user_id, created_at')
        ).toBeUndefined();
    });

    it('never suggests a column the table does not have', () => {
        // A join puts another table's filters in the same query. Suggesting an
        // index on a column that is not there produces DDL that simply fails,
        // which is worse than saying nothing.
        const advice = summariseTable(
            'demo.users',
            [seen(['status'], 0), seen(['status'], 0)].map(o => ({ ...o, table: 'demo.users' })),
            'user_id',
            ['user_id', 'signup_date', 'plan', 'country']
        );
        expect(advice).toBeUndefined();
    });

    it('suggests the column when the table really does have it', () => {
        const advice = summariseTable(
            'demo.orders',
            [seen(['status'], 0), seen(['status'], 0)],
            'user_id, created_at',
            ['order_id', 'user_id', 'status', 'amount']
        );
        expect(advice?.column).toBe('status');
    });

    it('picks the best column the table actually has, not merely the commonest', () => {
        const advice = summariseTable(
            'demo.orders',
            [seen(['status', 'amount'], 0), seen(['status', 'amount'], 0), seen(['status'], 0)],
            'user_id',
            ['order_id', 'user_id', 'amount']
        );
        expect(advice?.column).toBe('amount');
    });

    it('writes the alternative as something to read, not to run', () => {
        const advice = summariseTable(
            'demo.orders',
            [seen(['status'], 0), seen(['status'], 0)],
            'user_id, created_at'
        );
        expect(advice?.ddl).toMatch(/^--/m);
        expect(advice?.note).toContain('rewrites the table');
    });
});

describe('ObservationStore', () => {
    function store() {
        let held: unknown = [];
        const memento = {
            get: <T>(_key: string, fallback: T) => (held as T) ?? fallback,
            update: async (_key: string, value: unknown) => {
                held = value;
            },
        };
        return new ObservationStore(memento);
    }

    const entry = (over: Partial<Observation> = {}): Observation => ({
        at: Date.now(),
        table: 'demo.orders',
        prunedFraction: 0,
        rowsRead: 1,
        filteredColumns: ['status'],
        ...over,
    });

    it('keeps what it is given', async () => {
        const kept = store();
        await kept.record([entry(), entry()]);
        expect(kept.all()).toHaveLength(2);
    });

    it('forgets observations older than a month, since the table has moved on', async () => {
        const kept = store();
        const old = Date.now() - 40 * 24 * 60 * 60 * 1000;
        await kept.record([entry({ at: old }), entry()]);
        expect(kept.all()).toHaveLength(1);
    });

    it('names only the tables seen often enough to mean something', async () => {
        const kept = store();
        await kept.record([entry(), entry(), entry({ table: 'demo.events' })]);
        expect(kept.tables()).toEqual(['demo.orders']);
    });

    it('can be told to forget everything', async () => {
        const kept = store();
        await kept.record([entry()]);
        await kept.forget();
        expect(kept.all()).toEqual([]);
    });
});
