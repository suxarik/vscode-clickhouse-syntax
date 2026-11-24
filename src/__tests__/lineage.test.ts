/**
 * Tests for table lineage: how definitions become a graph, what is said about
 * it, and that the page treats table names as untrusted text.
 */
import { toRows } from '../lineage/fetch';
import {
    TableRow,
    buildGraph,
    connectedTables,
    engineArguments,
    lineageFindings,
    lineageOf,
    viewTarget,
} from '../lineage/graph';
import { iconSvg } from '../webview/icons';
import { renderLineage } from '../lineage/render';

const table = (database: string, name: string, over: Partial<TableRow> = {}): TableRow => ({
    database,
    name,
    engine: 'MergeTree',
    engineFull: 'MergeTree ORDER BY id',
    createQuery: '',
    uuid: '',
    dependents: [],
    ...over,
});

const view = (database: string, name: string, createQuery: string, uuid = ''): TableRow =>
    table(database, name, { engine: 'MaterializedView', engineFull: '', createQuery, uuid });

describe('viewTarget', () => {
    it('reads the table a view writes to', () => {
        expect(viewTarget('CREATE MATERIALIZED VIEW app.mv TO app.daily (d Date) AS SELECT 1', 'app')).toEqual({
            database: 'app',
            table: 'daily',
        });
    });

    it("handles the server's normalised form, with a uuid and a cluster", () => {
        const ddl =
            "CREATE MATERIALIZED VIEW app.mv UUID '9e7f056a-2434-4cd1-b2af-46877ee1ad66' ON CLUSTER main TO app.daily (`d` Date) AS SELECT 1";
        expect(viewTarget(ddl, 'app')).toEqual({ database: 'app', table: 'daily' });
    });

    it('reads backticked names, and puts a bare name in the view own database', () => {
        expect(viewTarget('CREATE MATERIALIZED VIEW app.mv TO `odd-db`.`wei rd` AS SELECT 1', 'app')).toEqual({
            database: 'odd-db',
            table: 'wei rd',
        });
        expect(viewTarget('CREATE MATERIALIZED VIEW mv TO daily AS SELECT 1', 'app')).toEqual({
            database: 'app',
            table: 'daily',
        });
    });

    it('says nothing for a view that keeps its own table', () => {
        expect(
            viewTarget('CREATE MATERIALIZED VIEW app.mv ENGINE = MergeTree ORDER BY d AS SELECT 1', 'app')
        ).toBeUndefined();
    });

    it('does not take a TO from inside the query', () => {
        expect(
            viewTarget(
                'CREATE MATERIALIZED VIEW app.mv ENGINE = Memory AS SELECT x FROM a WHERE y IN (SELECT 1) TO b',
                'app'
            )
        ).toBeUndefined();
    });
});

describe('engineArguments', () => {
    it('reads quoted and bare arguments', () => {
        expect(engineArguments("Distributed('lab', 'app', 'events', rand())", 'app')).toEqual(['lab', 'app', 'events']);
        expect(engineArguments('Distributed(lab, app, events)', 'app')).toEqual(['lab', 'app', 'events']);
        expect(engineArguments("Buffer('app', 'events', 1, 10, 100)", 'app')).toEqual([
            'app',
            'events',
            '1',
            '10',
            '100',
        ]);
    });

    it('resolves currentDatabase() to the owning database', () => {
        expect(engineArguments("Distributed('lab', currentDatabase(), 'events')", 'shop')?.slice(0, 3)).toEqual([
            'lab',
            'shop',
            'events',
        ]);
    });

    it('is not an engine it does not know', () => {
        expect(engineArguments('MergeTree ORDER BY id', 'app')).toBeUndefined();
    });
});

describe('the graph', () => {
    const rows = [
        table('app', 'events', {
            dependents: [
                { database: 'app', table: 'daily_mv' },
                { database: 'app', table: 'users_mv' },
            ],
        }),
        table('app', 'daily'),
        view('app', 'daily_mv', 'CREATE MATERIALIZED VIEW app.daily_mv TO app.daily AS SELECT 1'),
        view(
            'app',
            'users_mv',
            'CREATE MATERIALIZED VIEW app.users_mv ENGINE = AggregatingMergeTree AS SELECT 1',
            'u-1'
        ),
        table('app', '.inner_id.u-1'),
        table('app', 'events_dist', {
            engine: 'Distributed',
            engineFull: "Distributed('lab', 'app', 'events', rand())",
        }),
        table('app', 'lonely'),
    ];
    const graph = buildGraph(rows);

    it('follows a view from its source to its target, with the view in between', () => {
        const { downstream } = lineageOf(graph, 'app.events');
        const views = downstream.children.map(child => child.name).sort();
        expect(views).toEqual(['app.daily_mv', 'app.users_mv']);
        const daily = downstream.children.find(child => child.name === 'app.daily_mv')!;
        expect(daily.children.map(child => child.name)).toEqual(['app.daily']);
    });

    it('finds the table a view made for itself, by uuid', () => {
        const users = lineageOf(graph, 'app.events').downstream.children.find(child => child.name === 'app.users_mv')!;
        expect(users.children.map(child => child.name)).toEqual(['app..inner_id.u-1']);
    });

    it('walks upstream from a target to everything that feeds it', () => {
        const { upstream } = lineageOf(graph, 'app.daily');
        expect(upstream.children[0].name).toBe('app.daily_mv');
        expect(upstream.children[0].children[0].name).toBe('app.events');
        // The Distributed table forwards into the source, so the trail goes on through it.
        expect(upstream.children[0].children[0].children.map(child => child.name)).toEqual(['app.events_dist']);
    });

    it('sees a Distributed table as feeding the local one', () => {
        expect(lineageOf(graph, 'app.events').upstream.children.map(child => child.name)).toEqual(['app.events_dist']);
    });

    it('lists only tables that take part in something', () => {
        expect(connectedTables(graph)).not.toContain('app.lonely');
        expect(connectedTables(graph)).toContain('app.events');
    });

    it('does not loop on a cycle', () => {
        const loop = buildGraph([
            table('a', 'x', { dependents: [{ database: 'a', table: 'v1' }] }),
            view('a', 'v1', 'CREATE MATERIALIZED VIEW a.v1 TO a.y AS SELECT 1'),
            table('a', 'y', { dependents: [{ database: 'a', table: 'v2' }] }),
            view('a', 'v2', 'CREATE MATERIALIZED VIEW a.v2 TO a.x AS SELECT 1'),
        ]);
        const text = JSON.stringify(lineageOf(loop, 'a.x').downstream);
        expect(text).toContain('"cycle":true');
    });
});

describe('findings', () => {
    it('names a view whose target is gone, and what that does to inserts', () => {
        const graph = buildGraph([
            table('app', 'events', { dependents: [{ database: 'app', table: 'mv' }] }),
            view('app', 'mv', 'CREATE MATERIALIZED VIEW app.mv TO app.gone AS SELECT 1'),
        ]);
        const [finding] = lineageFindings(graph, 'app.events');
        expect(finding).toMatchObject({
            ruleId: 'target-missing',
            importance: 'high',
            title: 'app.gone does not exist',
        });
        expect(finding.suggestion).toContain('inserts to the source fail too');
    });

    it('ignores a broken pipeline that is not connected to the table in question', () => {
        const graph = buildGraph([
            table('app', 'events'),
            table('other', 'src', { dependents: [{ database: 'other', table: 'mv' }] }),
            view('other', 'mv', 'CREATE MATERIALIZED VIEW other.mv TO other.gone AS SELECT 1'),
        ]);
        expect(lineageFindings(graph, 'app.events')).toEqual([]);
        expect(lineageFindings(graph, 'other.src')).toHaveLength(1);
    });

    it('notes a table that runs many views', () => {
        const names = ['a', 'b', 'c', 'd', 'e'];
        const graph = buildGraph([
            table('app', 'events', { dependents: names.map(n => ({ database: 'app', table: n })) }),
            ...names.map(n => view('app', n, `CREATE MATERIALIZED VIEW app.${n} TO app.t_${n} AS SELECT 1`)),
            ...names.map(n => table('app', `t_${n}`)),
        ]);
        const found = lineageFindings(graph, 'app.events');
        expect(found.map(finding => finding.ruleId)).toEqual(['many-views']);
        expect(found[0].title).toContain('5 materialized views');
    });
});

describe('reading', () => {
    it('pairs each dependent table with its database', () => {
        const [row] = toRows({
            queryId: '',
            columns: ['database', 'name', 'dependencies_database', 'dependencies_table'].map(name => ({
                name,
                type: 'String',
            })),
            rows: [['app', 'events', ['app', 'other'], ['mv1', 'mv2']]],
            truncated: false,
            elapsedMs: 0,
        });
        expect(row.dependents).toEqual([
            { database: 'app', table: 'mv1' },
            { database: 'other', table: 'mv2' },
        ]);
    });
});

describe('the page', () => {
    it('escapes table names, including in the attribute a click reads', () => {
        const hostile = '"><script>alert(1)</script>';
        const graph = buildGraph([
            table('app', 'events', { dependents: [{ database: 'app', table: 'mv' }] }),
            view('app', 'mv', `CREATE MATERIALIZED VIEW app.mv TO app.\`${hostile}\` AS SELECT 1`),
            table('app', hostile),
        ]);
        const { upstream, downstream } = lineageOf(graph, 'app.events');
        const html = renderLineage('app.events', upstream, downstream, lineageFindings(graph, 'app.events'));
        expect(html).not.toContain('<script>');
        expect(html).not.toContain('data-focus=""><');
        expect(html).toContain('&lt;script&gt;');
    });

    it('marks a missing table as missing rather than as a link', () => {
        const graph = buildGraph([
            table('app', 'events', { dependents: [{ database: 'app', table: 'mv' }] }),
            view('app', 'mv', 'CREATE MATERIALIZED VIEW app.mv TO app.gone AS SELECT 1'),
        ]);
        const { upstream, downstream } = lineageOf(graph, 'app.events');
        const html = renderLineage('app.events', upstream, downstream, []);
        expect(html).toContain('does not exist');
        expect(html).not.toContain('data-focus="app.gone"');
        expect(html).toContain('data-focus="app.mv"');
    });

    it('draws each table with the icon the explorer gives its engine', () => {
        const graph = buildGraph([
            table('app', 'events', { dependents: [{ database: 'app', table: 'mv' }] }),
            view('app', 'mv', 'CREATE MATERIALIZED VIEW app.mv TO app.gone AS SELECT 1'),
        ]);
        const { upstream, downstream } = lineageOf(graph, 'app.events');
        const html = renderLineage('app.events', upstream, downstream, []);
        // MergeTree is 'layers' and a materialized view 'zap' in the explorer.
        expect(html).toContain(iconSvg('layers'));
        expect(html).toContain(iconSvg('zap'));
        expect(html).toContain(iconSvg('error'));
        expect(iconSvg('layers')).not.toBe(iconSvg('zap'));
    });

    it('falls back to the table icon for a name it has no drawing for', () => {
        expect(iconSvg('no-such-icon')).toBe(iconSvg('table'));
    });

    it('says so when a table is not connected to anything', () => {
        const graph = buildGraph([table('app', 'lonely')]);
        const { upstream, downstream } = lineageOf(graph, 'app.lonely');
        const html = renderLineage('app.lonely', upstream, downstream, []);
        expect(html).toContain('feeds nothing');
        expect(html).not.toContain('class="card');
    });
});
