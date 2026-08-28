/**
 * Tests for reading a ClickHouse query plan.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    buildExplainDocument,
    describeIndex,
    parsePlan,
    prefixWidth,
    renderTree,
    summarizePlan,
} from '../client/explain';

/** A real `EXPLAIN PLAN indexes = 1` from ClickHouse 26. */
const REAL_PLAN = fs.readFileSync(path.join(__dirname, 'fixtures-plan.txt'), 'utf8');

describe('prefixWidth', () => {
    it('counts spaces', () => {
        expect(prefixWidth('      Read type: Default')).toBe(6);
    });

    it('counts box-drawing prefixes, which spaces alone would miss', () => {
        expect(prefixWidth('│  Keys: user_id')).toBe(3);
        expect(prefixWidth('└──ReadFromMergeTree (db.t)')).toBe(3);
    });

    it('is zero for a bare line', () => {
        expect(prefixWidth('Aggregating')).toBe(0);
    });
});

describe('parsePlan', () => {
    it('nests plain indentation', () => {
        const nodes = parsePlan('Parent\n  Child\n    Grandchild');
        expect(nodes).toHaveLength(1);
        expect(nodes[0].children[0].text).toBe('Child');
        expect(nodes[0].children[0].children[0].text).toBe('Grandchild');
    });

    it('nests a real ClickHouse plan', () => {
        const nodes = parsePlan(REAL_PLAN);
        const aggregating = nodes.find(node => node.text === 'Aggregating')!;
        expect(aggregating).toBeDefined();
        const read = aggregating.children.find(node => node.text.startsWith('ReadFromMergeTree'))!;
        expect(read).toBeDefined();
        expect(read.children.some(node => node.text === 'Indexes:')).toBe(true);
    });

    it('strips the drawing characters from the text', () => {
        const nodes = parsePlan(REAL_PLAN);
        for (const node of nodes) expect(node.text).not.toMatch(/[│├└─]/);
    });

    it('ignores blank lines', () => {
        expect(parsePlan('A\n\n\nB')).toHaveLength(2);
    });

    it('handles empty input', () => {
        expect(parsePlan('')).toEqual([]);
    });
});

describe('summarizePlan', () => {
    const summary = summarizePlan(parsePlan(REAL_PLAN));

    it('names the tables read', () => {
        expect(summary.tables).toEqual(['analytics.events']);
    });

    it('reads each index and its pruning', () => {
        const minMax = summary.indexes.find(index => index.indexName === 'Min-Max')!;
        expect(minMax).toMatchObject({
            table: 'analytics.events',
            partsSelected: 1,
            partsTotal: 3,
            granulesSelected: 8,
            granulesTotal: 24,
        });
        expect(minMax.condition).toContain('event_date');
    });

    it('finds every index', () => {
        expect(summary.indexes.map(index => index.indexName).sort()).toEqual([
            'Min-Max',
            'Partition',
            'PrimaryKey',
        ]);
    });

    it('does not mistake a property for an index', () => {
        // `Ranges: 1` sits beside the indexes but is not one.
        expect(summary.indexes.some(index => index.indexName?.startsWith('Ranges'))).toBe(false);
    });

    it('reports that pruning happened', () => {
        expect(summary.prunes).toBe(true);
    });

    it('reports no pruning when nothing was removed', () => {
        const plan = [
            'ReadFromMergeTree (db.t)',
            '  Indexes:',
            '    PrimaryKey',
            '      Parts: 4/4',
            '      Granules: 100/100',
        ].join('\n');
        expect(summarizePlan(parsePlan(plan)).prunes).toBe(false);
    });
});

describe('describeIndex', () => {
    it('states the fractions and their percentages', () => {
        expect(
            describeIndex({ indexName: 'PrimaryKey', partsSelected: 1, partsTotal: 4, granulesSelected: 8, granulesTotal: 24 })
        ).toBe('PrimaryKey  parts 1/4 (25.0%)  granules 8/24 (33.3%)');
    });

    it('copes with an index that reports nothing', () => {
        expect(describeIndex({ indexName: 'Skip' })).toBe('Skip');
    });
});

describe('renderTree', () => {
    it('draws the shape', () => {
        const lines = renderTree(parsePlan('A\n  B\n  C'));
        expect(lines[0]).toContain('A');
        expect(lines[1]).toContain('B');
        expect(lines[2]).toContain('C');
        // The last child is drawn differently from its siblings.
        expect(lines[1][3]).not.toBe(lines[2][3]);
    });
});

describe('buildExplainDocument', () => {
    const document = buildExplainDocument({
        kind: 'PLAN',
        sql: 'SELECT user_id FROM analytics.events',
        profile: 'prod',
        raw: REAL_PLAN,
    });

    it('leads with the summary, not the raw plan', () => {
        expect(document.indexOf('Index usage')).toBeLessThan(document.indexOf('Plan'));
        expect(document).toContain('Tables read: analytics.events');
    });

    it('reports the profile and the statement', () => {
        expect(document).toContain('prod');
        expect(document).toContain('SELECT user_id FROM analytics.events');
    });

    it('shows the pruning numbers', () => {
        expect(document).toContain('parts 1/3');
        expect(document).toContain('granules 8/24');
    });

    it('says plainly when nothing was pruned', () => {
        const plan = ['ReadFromMergeTree (db.t)', '  Indexes:', '    PrimaryKey', '      Parts: 4/4'].join('\n');
        expect(buildExplainDocument({ kind: 'PLAN', sql: 'x', profile: 'p', raw: plan })).toContain(
            'reads everything'
        );
    });

    it('suggests indexes = 1 when there is no index information', () => {
        expect(
            buildExplainDocument({ kind: 'PLAN', sql: 'x', profile: 'p', raw: 'ReadFromMergeTree (db.t)' })
        ).toContain('indexes = 1');
    });

    it('handles an empty plan', () => {
        expect(buildExplainDocument({ kind: 'AST', sql: 'x', profile: 'p', raw: '' })).toContain('(empty)');
    });
});
