/**
 * Tests for storage health: what is read, what is said about it, and that
 * nothing from the server can become markup.
 */
import { DEFAULT_LIMITS, HealthClient, fetchHealth } from '../health/fetch';
import { diskTone, escapeHtml, partsTone, renderHealth } from '../health/render';
import { healthFindings } from '../health/rules';
import { HealthView } from '../health/types';
import { QueryResult } from '../client/types';

const view = (over: Partial<HealthView> = {}): HealthView => ({
    partitions: [],
    merges: [],
    mutations: [],
    disks: [],
    detached: [],
    limits: DEFAULT_LIMITS,
    limitsFromServer: true,
    unavailable: [],
    ...over,
});

const partition = (parts: number, over = {}) => ({
    database: 'demo',
    table: 'events',
    partition: '202611',
    parts,
    rows: parts * 1000,
    bytes: parts * 50 * 1024 * 1024,
    ...over,
});

const ids = (v: HealthView) => healthFindings(v).map(finding => finding.ruleId);

describe('parts', () => {
    it('says nothing about an ordinary table', () => {
        expect(ids(view({ partitions: [partition(20)] }))).toEqual([]);
    });

    it('warns before inserts fail, using the limit the server has', () => {
        const found = healthFindings(view({ partitions: [partition(2500)] }));
        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ ruleId: 'parts-near-throw', importance: 'high' });
        expect(found[0].evidence).toContain('3000');
        expect(found[0].subject).toEqual({ kind: 'table', name: 'demo.events' });
    });

    it('follows a raised limit instead of assuming the default', () => {
        const raised = view({ partitions: [partition(2500)], limits: { delayAt: 5000, throwAt: 10000 } });
        expect(ids(raised)).toEqual([]);
    });

    it('notes that inserts are being slowed, short of failing', () => {
        expect(ids(view({ partitions: [partition(850)] }))).toEqual(['parts-near-delay']);
    });

    it('only calls many parts a problem when they are also small', () => {
        expect(ids(view({ partitions: [partition(150)] }))).toEqual([]);
        const tiny = partition(150, { bytes: 150 * 10 * 1024 });
        expect(ids(view({ partitions: [tiny] }))).toEqual(['many-small-parts']);
    });

    it('gives one finding per table, for its worst partition', () => {
        const found = healthFindings(
            view({
                partitions: [
                    partition(2900, { partition: '202610' }),
                    partition(2800, { partition: '202611' }),
                    partition(2700, { partition: '202612' }),
                ],
            })
        );
        expect(found).toHaveLength(1);
        expect(found[0].evidence).toContain('2900');
        expect(found[0].evidence).toContain('202610');
    });
});

describe('mutations', () => {
    const mutation = (over = {}) => ({
        database: 'demo',
        table: 'events',
        id: 'mutation_7.txt',
        command: 'DELETE WHERE user_id = 5',
        ageSeconds: 600,
        partsToDo: 3,
        failReason: '',
        ...over,
    });

    it('treats a failing mutation as the problem, with the way out', () => {
        const [finding] = healthFindings(
            view({ mutations: [mutation({ failReason: 'Code: 241. Memory limit exceeded' })] })
        );
        expect(finding).toMatchObject({ ruleId: 'mutation-stuck', importance: 'high' });
        expect(finding.evidence).toContain('Memory limit exceeded');
        expect(finding.suggestion).toContain("KILL MUTATION WHERE database = 'demo'");
        expect(finding.suggestion).toContain("mutation_id = 'mutation_7.txt'");
    });

    it('leaves a young mutation alone and calls an old healthy one slow', () => {
        expect(ids(view({ mutations: [mutation()] }))).toEqual([]);
        expect(ids(view({ mutations: [mutation({ ageSeconds: 7200 })] }))).toEqual(['mutation-slow']);
    });
});

describe('merges, disks and detached parts', () => {
    it('mentions only merges that have run a long time', () => {
        const merge = (elapsedSeconds: number) => ({
            database: 'demo',
            table: 'events',
            elapsedSeconds,
            progress: 0.4,
            numParts: 12,
            bytes: 5e9,
            isMutation: false,
        });
        expect(ids(view({ merges: [merge(120)] }))).toEqual([]);
        const [finding] = healthFindings(view({ merges: [merge(7500)] }));
        expect(finding.ruleId).toBe('merge-long');
        expect(finding.title).toContain('2h 5m');
        expect(finding.evidence).toContain('40.0% done');
    });

    it('grades disks by how little is left', () => {
        const disk = (free: number) => ({ name: 'default', freeBytes: free, totalBytes: 100 });
        expect(ids(view({ disks: [disk(50)] }))).toEqual([]);
        expect(healthFindings(view({ disks: [disk(15)] }))[0].importance).toBe('medium');
        expect(healthFindings(view({ disks: [disk(4)] }))[0].importance).toBe('high');
    });

    it('treats parts the server set aside as worse than ones someone detached', () => {
        const [broken] = healthFindings(
            view({ detached: [{ database: 'demo', table: 'events', reason: 'broken', parts: 2 }] })
        );
        expect(broken).toMatchObject({ ruleId: 'detached-broken', importance: 'high' });

        const [manual] = healthFindings(
            view({ detached: [{ database: 'demo', table: 'events', reason: '', parts: 1 }] })
        );
        expect(manual).toMatchObject({ ruleId: 'detached-parts', importance: 'low' });
        expect(manual.evidence).toContain('detached by hand');
    });

    it('puts the most serious finding first', () => {
        const found = healthFindings(
            view({
                partitions: [partition(150, { bytes: 150 * 1024 })],
                disks: [{ name: 'default', freeBytes: 3, totalBytes: 100 }],
            })
        );
        expect(found.map(finding => finding.importance)).toEqual(['high', 'low']);
    });
});

describe('reading', () => {
    const answer = (columns: string[], rows: unknown[][]): QueryResult => ({
        queryId: 'q',
        columns: columns.map(name => ({ name, type: 'String' })),
        rows,
        truncated: false,
        elapsedMs: 1,
    });

    /** A client that answers by the table named in the statement. */
    function client(
        replies: Record<string, QueryResult | Error>,
        seen: Array<{ sql: string; options?: unknown }> = []
    ): HealthClient {
        return {
            async query(sql, options) {
                seen.push({ sql, options });
                for (const [needle, reply] of Object.entries(replies)) {
                    if (!sql.includes(needle)) continue;
                    if (reply instanceof Error) throw reply;
                    return reply;
                }
                return answer([], []);
            },
        };
    }

    it('reads the thresholds from the server', async () => {
        const result = await fetchHealth(
            client({
                merge_tree_settings: answer(
                    ['name', 'value'],
                    [
                        ['parts_to_delay_insert', '2000'],
                        ['parts_to_throw_insert', '6000'],
                    ]
                ),
            })
        );
        expect(result.limits).toEqual({ delayAt: 2000, throwAt: 6000 });
        expect(result.limitsFromServer).toBe(true);
    });

    it('falls back to the defaults, and says so, when the server cannot be asked', async () => {
        const result = await fetchHealth(client({ merge_tree_settings: new Error('no rights') }));
        expect(result.limits).toEqual(DEFAULT_LIMITS);
        expect(result.limitsFromServer).toBe(false);
    });

    it('names what it could not read and still returns the rest', async () => {
        const result = await fetchHealth(
            client({
                'system.mutations': new Error('ACCESS_DENIED'),
                'system.parts': answer(
                    ['database', 'table', 'partition', 'parts', 'rows', 'bytes'],
                    [['demo', 'events', '202611', '12', '1000', '2048']]
                ),
            })
        );
        expect(result.unavailable).toEqual(['mutations']);
        expect(result.partitions).toEqual([
            { database: 'demo', table: 'events', partition: '202611', parts: 12, rows: 1000, bytes: 2048 },
        ]);
    });

    it('never asks for anything but a read, and puts scope in parameters rather than the text', async () => {
        const seen: Array<{ sql: string; options?: unknown }> = [];
        await fetchHealth(client({}, seen), { database: 'demo', table: "ev'ents" });

        expect(seen.length).toBeGreaterThanOrEqual(6);
        for (const call of seen) expect(call.options).toMatchObject({ readOnly: true });

        const scoped = seen.filter(call => call.sql.includes('{database:String}'));
        expect(scoped.length).toBeGreaterThanOrEqual(4);
        for (const call of scoped) {
            expect(call.sql).not.toContain("ev'ents");
            expect(call.options).toMatchObject({ parameters: { database: 'demo', table: "ev'ents" } });
        }
        // Disks belong to the server, so a table does not narrow them.
        expect(seen.find(call => call.sql.includes('system.disks'))?.sql).not.toContain('{database');
    });

    it("shows a mutation's command without the parentheses ClickHouse wraps it in", async () => {
        const result = await fetchHealth(
            client({
                'system.mutations': answer(
                    ['database', 'table', 'mutation_id', 'command', 'age', 'parts_to_do', 'latest_fail_reason'],
                    [['demo', 'events', 'mutation_1.txt', '(DELETE WHERE user_id = 5)', '30', '2', '']]
                ),
            })
        );
        expect(result.mutations[0].command).toBe('DELETE WHERE user_id = 5');
    });

    it('drops disks that report no capacity', async () => {
        const result = await fetchHealth(
            client({
                'system.disks': answer(
                    ['name', 'free_space', 'total_space'],
                    [
                        ['default', '10', '100'],
                        ['s3', '0', '0'],
                    ]
                ),
            })
        );
        expect(result.disks.map(disk => disk.name)).toEqual(['default']);
    });
});

describe('the page', () => {
    it('escapes anything the server says', () => {
        expect(escapeHtml(`<img src=x onerror="a()"> & 'q'`)).toBe(
            '&lt;img src=x onerror=&quot;a()&quot;&gt; &amp; &#39;q&#39;'
        );

        const hostile = '<script>alert(1)</script>';
        const hostileView = view({
            partitions: [partition(2900, { table: hostile })],
            mutations: [
                {
                    database: 'demo',
                    table: hostile,
                    id: hostile,
                    command: hostile,
                    ageSeconds: 5,
                    partsToDo: 1,
                    failReason: hostile,
                },
            ],
        });
        const html = renderHealth(hostileView, healthFindings(hostileView), 0);
        expect(html).not.toContain('<script>');
        expect(html).toContain('&lt;script&gt;');
    });

    it('says when something could not be read instead of looking healthy', () => {
        const html = renderHealth(view({ unavailable: ['mutations'] }), [], 0);
        expect(html).toContain('Could not read: mutations');
        expect(html).toContain('not the same as being healthy');
    });

    it('says nothing could be said when nothing could be read', () => {
        const all = ['detached parts', 'disks', 'merges', 'mutations', 'parts'];
        expect(renderHealth(view({ unavailable: all }), [], 0)).toContain('nothing can be said');
    });

    it('reports a clean server as clean, and says whose limits it used', () => {
        expect(renderHealth(view(), [], 0)).toContain('Nothing to report');
        const defaults = renderHealth(view({ limitsFromServer: false, partitions: [partition(5)] }), [], 0);
        expect(defaults).toContain('ClickHouse defaults');
    });
});

describe('the modern page', () => {
    const html = (v: HealthView) => renderHealth(v, healthFindings(v), 0);

    it('grades parts against the limit the server gave, and disks by what is left', () => {
        expect(partsTone(20, DEFAULT_LIMITS)).toBe('good');
        expect(partsTone(1500, DEFAULT_LIMITS)).toBe('warn');
        expect(partsTone(2500, DEFAULT_LIMITS)).toBe('bad');
        expect(partsTone(85, { delayAt: 60, throwAt: 100 })).toBe('bad');
        expect(diskTone(50)).toBe('good');
        expect(diskTone(15)).toBe('warn');
        expect(diskTone(5)).toBe('bad');
    });

    it('opens with a summary tile for each thing it could read', () => {
        const page = html(view({ partitions: [partition(2500)] }));
        expect(page).toContain('Fullest partition');
        expect(page).toContain('2,500 parts');
        expect(page).toContain('83% of the 3,000 limit');
        expect(page).toContain('1 to look at');
        for (const label of ['Mutations', 'Merges running', 'Detached parts']) expect(page).toContain(label);
    });

    it('leaves out the tile for what could not be read rather than showing a zero', () => {
        const page = html(view({ unavailable: ['mutations', 'detached parts'] }));
        expect(page).not.toContain('>Mutations<');
        expect(page).not.toContain('>Detached parts<');
        expect(page).toContain('For what could be read');
    });

    it('marks a failing mutation and shows why', () => {
        const page = html(
            view({
                mutations: [
                    {
                        database: 'demo',
                        table: 'events',
                        id: 'mutation_1.txt',
                        command: 'DELETE WHERE 1',
                        ageSeconds: 4000,
                        partsToDo: 3,
                        failReason: 'Code: 395',
                    },
                ],
            })
        );
        expect(page).toContain('class="failing"');
        expect(page).toContain('failing</span>');
        expect(page).toContain('Code: 395');
        expect(page).toContain('1 failing');
    });

    it('sizes a partition bar against the throw limit and marks where inserts slow', () => {
        const page = html(view({ partitions: [partition(1500)] }));
        expect(page).toContain('--w:50.0%');
        expect(page).toContain('--m:33.3%');
    });

    it('gives each partition row lower-cased text to search, escaped', () => {
        const page = html(view({ partitions: [partition(5, { table: 'Events"><b>' })] }));
        const searchable = /data-s="([^"]*)"/.exec(page)?.[1] ?? '';
        expect(searchable).toContain('demo.events&quot;&gt;&lt;b&gt;');
        expect(page).not.toContain('"><b>');
    });

    it('draws a finding with its severity and the way out', () => {
        const page = html(view({ partitions: [partition(2500)] }));
        expect(page).toContain('class="finding high"');
        expect(page).toContain('class="badge">high<');
        expect(page).toContain('class="suggest"');
    });

    it('shows a disk as used against what is free', () => {
        const page = html(view({ disks: [{ name: 'default', freeBytes: 5, totalBytes: 100 }] }));
        expect(page).toContain('5.0% free');
        expect(page).toContain('--w:95.0%');
        expect(page).toContain('Least free disk');
    });
});
