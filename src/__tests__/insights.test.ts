/**
 * Tests for query insights: what is asked of the log, what is said about each
 * statement, and that the page treats the log as hostile text.
 */
import { LIMIT, fetchInsights, insightsSql, toShapes } from '../insights/fetch';
import { parseMessage } from '../insights/panel';
import { notesFor, renderInsights, latencyTone, memoryTone } from '../insights/render';
import { exportShapes } from '../insights/export';
import { LENSES, Lens, QueryShape } from '../insights/types';
import { QueryResult } from '../client/types';

const shape = (over: Partial<QueryShape> = {}): QueryShape => ({
    hash: '1',
    example: 'SELECT 1',
    user: 'default',
    runs: 10,
    totalMs: 1000,
    p95Ms: 120,
    maxMs: 150,
    avgReadRows: 1000,
    avgReadBytes: 8000,
    avgResultRows: 1000,
    peakMemory: 1024,
    errors: 0,
    lastError: '',
    lastErrorCode: 0,
    tables: ['demo.events'],
    ...over,
});

describe('the query', () => {
    it('orders by what each lens is about', () => {
        expect(insightsSql('time')).toContain('ORDER BY total_ms DESC');
        expect(insightsSql('memory')).toContain('ORDER BY peak_memory DESC');
        expect(insightsSql('scanned')).toContain('ORDER BY read_rows_total DESC');
        expect(insightsSql('errors')).toContain('HAVING errors > 0');
        expect(insightsSql('time')).not.toContain('HAVING');
    });

    it('takes the window as a parameter and never as text', () => {
        for (const lens of Object.keys(LENSES) as Lens[]) {
            expect(insightsSql(lens)).toContain('{hours:UInt32}');
        }
    });

    it('does not name an output column after one it reads from', () => {
        // `AS tables` would shadow the `tables` column inside WHERE, and ClickHouse
        // then refuses the whole query for filtering on an aggregate.
        expect(insightsSql('time')).not.toMatch(/AS tables\b/);
    });

    it('leaves out the log reading itself, and only that', () => {
        const sql = insightsSql('time');
        expect(sql).toContain("startsWith(t, 'system.')");
        expect(sql).toContain('notEmpty(tables)');
        expect(sql).toContain("type != 'QueryStart'");
    });

    it('reads as the server, read-only, with the window as a parameter', async () => {
        const calls: Array<{ sql: string; options?: unknown }> = [];
        const result: QueryResult = { queryId: '', columns: [], rows: [], truncated: false, elapsedMs: 0 };
        const view = await fetchInsights(
            {
                async query(sql, options) {
                    calls.push({ sql, options });
                    return result;
                },
            },
            'time',
            168
        );
        expect(calls[0].options).toMatchObject({ readOnly: true, parameters: { hours: '168' } });
        expect(view).toMatchObject({ lens: 'time', hours: 168, shapes: [] });
    });

    it('turns a row into a shape, tolerating nulls', () => {
        const shapes = toShapes({
            queryId: '',
            columns: ['hash', 'example', 'runs', 'touched', 'last_error'].map(name => ({ name, type: 'String' })),
            rows: [['9', 'SELECT 1', '3', ['a.b', 'c.d'], null]],
            truncated: false,
            elapsedMs: 0,
        });
        expect(shapes[0]).toMatchObject({ hash: '9', runs: 3, tables: ['a.b', 'c.d'], lastError: '', peakMemory: 0 });
    });
});

describe('what is said about a statement', () => {
    it('says nothing about an ordinary one', () => {
        expect(notesFor(shape())).toEqual([]);
    });

    it('notices a scan that returns almost nothing', () => {
        const [note] = notesFor(shape({ avgReadRows: 50_000_000, avgResultRows: 3 }));
        expect(note).toContain('50,000,000 rows');
        expect(note).toContain('return 3');
        expect(note).toContain('sorting key');
    });

    it('does not call a big aggregation over big data wasteful', () => {
        expect(notesFor(shape({ avgReadRows: 50_000_000, avgResultRows: 40_000_000 }))).toEqual([]);
        expect(notesFor(shape({ avgReadRows: 500_000, avgResultRows: 1 }))).toEqual([]);
    });

    it('notices an uneven tail only when there are enough runs to mean it', () => {
        const uneven = { totalMs: 1000, p95Ms: 900 };
        expect(notesFor(shape({ ...uneven, runs: 5 }))).toEqual([]);
        expect(notesFor(shape({ ...uneven, runs: 50, totalMs: 5000 }))[0]).toContain('Uneven');
    });

    it('states how often it failed', () => {
        const [note] = notesFor(shape({ errors: 3, runs: 12, lastErrorCode: 241 }));
        expect(note).toBe('Failed 3 of 12 runs (25%), code 241.');
    });
});

describe('the page', () => {
    it('escapes query text and exceptions from the log', () => {
        const hostile = '<script>alert(1)</script>';
        const html = renderInsights({
            lens: 'errors',
            hours: 24,
            shapes: [shape({ example: hostile, errors: 1, lastError: hostile, tables: [hostile], user: hostile })],
        });
        expect(html).not.toContain('<script>');
        expect(html).toContain('&lt;script&gt;');
    });

    it('marks the active lens and window', () => {
        const html = renderInsights({ lens: 'memory', hours: 6, shapes: [] });
        expect(html).toMatch(/toggle on" data-lens="memory"/);
        expect(html).toMatch(/toggle on" data-hours="6"/);
        expect(html).not.toMatch(/toggle on" data-lens="time"/);
    });

    it('explains an empty log instead of showing nothing', () => {
        expect(renderInsights({ lens: 'time', hours: 24, shapes: [] })).toContain('Nothing in system.query_log');
        expect(renderInsights({ lens: 'errors', hours: 24, shapes: [] })).toContain('No failing statements');
    });

    it('numbers each statement so Open can find it', () => {
        const html = renderInsights({ lens: 'time', hours: 24, shapes: [shape(), shape()] });
        expect(html).toContain('data-open="0"');
        expect(html).toContain('data-open="1"');
    });
});

describe('what the page may send', () => {
    it('passes a known lens and window, and drops anything else', () => {
        expect(parseMessage({ type: 'set', lens: 'memory', hours: 6 })).toEqual({
            type: 'set',
            lens: 'memory',
            hours: 6,
        });
        expect(parseMessage({ type: 'set', lens: 'drop table', hours: 7 })).toBeUndefined();
        expect(parseMessage({ type: 'set', lens: 'time', hours: 7 })).toEqual({
            type: 'set',
            lens: 'time',
            hours: undefined,
        });
    });

    it('only opens a real index', () => {
        expect(parseMessage({ type: 'open', index: 2 })).toEqual({ type: 'open', index: 2 });
        expect(parseMessage({ type: 'open', index: -1 })).toBeUndefined();
        expect(parseMessage({ type: 'open', index: 1.5 })).toBeUndefined();
        expect(parseMessage({ type: 'nope' } as never)).toBeUndefined();
        expect(parseMessage(undefined)).toBeUndefined();
    });
});

describe('listing many statements', () => {
    const many = Array.from({ length: 60 }, (_, i) => shape({ hash: String(i), example: `SELECT ${i}` }));

    it('asks for enough to page through, not a single screen', () => {
        expect(LIMIT).toBeGreaterThanOrEqual(100);
        expect(insightsSql('time')).toContain(`LIMIT ${LIMIT}`);
    });

    it('bounds how much of one statement is carried', () => {
        expect(insightsSql('time')).toMatch(/left\(argMax\(query, query_duration_ms\), \d+\) AS example/);
    });

    it('renders every row, for the page to filter and page in place', () => {
        const html = renderInsights({ lens: 'time', hours: 24, shapes: many });
        expect(html.match(/<tr data-i="/g)).toHaveLength(60);
        expect(html).toContain('id="search"');
        expect(html).toContain('id="prev"');
        expect(html).toContain('data-export="csv"');
        expect(html).toContain('data-export="json"');
        expect(html).toContain('data-sort="p95"');
    });

    it('offers no search or paging when there is nothing to search', () => {
        const html = renderInsights({ lens: 'time', hours: 24, shapes: [] });
        expect(html).not.toContain('id="search"');
        expect(html).not.toContain('id="prev"');
    });

    it('gives each row lower-cased text to search, covering statement, table, user and error', () => {
        const html = renderInsights({
            lens: 'errors',
            hours: 24,
            shapes: [
                shape({
                    example: 'SELECT Foo FROM Demo.Events',
                    user: 'Analyst',
                    errors: 1,
                    lastError: 'Code: 60. Table GONE',
                    tables: ['demo.events'],
                }),
            ],
        });
        const searchable = /data-s="([^"]*)"/.exec(html)?.[1] ?? '';
        for (const word of ['select foo from demo.events', 'analyst', 'table gone', 'demo.events']) {
            expect(searchable).toContain(word);
        }
        expect(searchable).toBe(searchable.toLowerCase());
    });

    it('escapes what a search is matched against too', () => {
        const html = renderInsights({
            lens: 'time',
            hours: 24,
            shapes: [shape({ example: 'x" onmouseover="alert(1)' })],
        });
        expect(html).not.toContain('" onmouseover="alert');
    });

    it('colours a slow tail and heavy memory, and leaves ordinary ones plain', () => {
        expect(latencyTone(120)).toBe('good');
        expect(latencyTone(2_000)).toBe('warn');
        expect(latencyTone(30_000)).toBe('bad');
        expect(memoryTone(100 * 1024 ** 2)).toBe('none');
        expect(memoryTone(2 * 1024 ** 3)).toBe('warn');
        expect(memoryTone(8 * 1024 ** 3)).toBe('bad');
    });

    it('puts the bar on the column the lens is about', () => {
        const html = renderInsights({ lens: 'memory', hours: 24, shapes: [shape({ peakMemory: 100 }), shape()] });
        // The larger of the two fills its cell, the other is sized against it.
        expect(html).toMatch(/<td class="n [a-z]* bar" style="--w:100%"><span>1.00 KiB/);
        expect(html).toMatch(/<td class="n [a-z]* bar" style="--w:10%"><span>100 B/);
        // And only that column carries one.
        expect(html.match(/ bar"/g)).toHaveLength(2);
    });
});

describe('exporting', () => {
    const rows = [
        { shape: shape({ example: 'SELECT "a",\n1', tables: ['a.b', 'c.d'], lastError: 'x' }), rank: 3 },
        { shape: shape({ example: 'SELECT 2' }), rank: 1 },
    ];

    it('writes CSV in the order given, quoting what needs it', () => {
        const lines = exportShapes(rows, 'csv').split('\n');
        expect(lines[0]).toMatch(/^rank,example,user,tables,runs,total_ms,p95_ms/);
        expect(exportShapes(rows, 'csv')).toContain('3,"SELECT ""a"",\n1",default,a.b; c.d,10,1000,120');
        expect(exportShapes(rows, 'csv').split('\n').at(-1)).toMatch(/^1,SELECT 2,/);
    });

    it('writes JSON with tables as a list and the same order', () => {
        const parsed = JSON.parse(exportShapes(rows, 'json'));
        expect(parsed.map((r: { rank: number }) => r.rank)).toEqual([3, 1]);
        expect(parsed[0].tables).toEqual(['a.b', 'c.d']);
        expect(parsed[0].p95_ms).toBe(120);
    });
});

describe('what an export message may carry', () => {
    it('keeps whole in-range positions once each, and a known format', () => {
        expect(parseMessage({ type: 'export', format: 'csv', indices: [2, 0, 2, 1.5, -1, 'x', LIMIT] })).toEqual({
            type: 'export',
            format: 'csv',
            indices: [2, 0],
        });
    });

    it('drops an unknown format, or nothing to export', () => {
        expect(parseMessage({ type: 'export', format: 'sql', indices: [0] })).toBeUndefined();
        expect(parseMessage({ type: 'export', format: 'json', indices: [] })).toBeUndefined();
        expect(parseMessage({ type: 'export', format: 'json', indices: 'all' })).toBeUndefined();
    });
});
