/**
 * @jest-environment node
 *
 * Tests for advice shown in the editor.
 */
import * as vscode from 'vscode';
import { AdviceDiagnostics } from '../advice/diagnostics';
import { Finding } from '../advice/types';
import { parse } from '../parser/parser';
import { docAt } from './helpers';

const finding: Finding = {
    ruleId: 'exact-distinct-cost',
    importance: 'medium',
    title: 'uniqExact accounts for most of this query',
    evidence: 'Aggregating used 84% of the query CPU time',
    suggestion: 'uniq() is approximate and costs far less.',
    subject: { kind: 'function', name: 'uniqExact' },
};

/** What the collection was last given for a document. */
function entriesOf(advice: AdviceDiagnostics): vscode.Diagnostic[] {
    const collection = (advice as unknown as { collection: { set: jest.Mock } }).collection;
    const last = collection.set.mock.calls[collection.set.mock.calls.length - 1];
    return (last?.[1] ?? []) as vscode.Diagnostic[];
}

describe('AdviceDiagnostics', () => {
    it('underlines the function a finding is about', () => {
        const advice = new AdviceDiagnostics();
        const { document } = docAt('SELECT uniqExact(user_id) FROM events');

        advice.show(document, { uri: document.uri, version: document.version, offset: 0, program: parse(document.getText()).program }, [finding]);

        const shown = entriesOf(advice);
        expect(shown).toHaveLength(1);
        expect(shown[0].message).toContain('84%');
        expect(shown[0].code).toBe('exact-distinct-cost');
    });

    it('offsets the range by where the statement started', () => {
        const advice = new AdviceDiagnostics();
        const text = 'SELECT 1;\nSELECT uniqExact(x) FROM t';
        const { document } = docAt(text);
        const offset = text.indexOf('SELECT uniqExact');

        advice.show(document, { uri: document.uri, version: document.version, offset, program: parse(text.slice(offset)).program }, [finding]);

        const shown = entriesOf(advice);
        expect(document.getText(shown[0].range)).toBe('uniqExact');
    });

    it('shows nothing for a finding with nowhere to point', () => {
        const advice = new AdviceDiagnostics();
        const { document } = docAt('SELECT 1');
        const whole: Finding = { ruleId: 'r', importance: 'low', title: 't', evidence: 'e' };

        advice.show(document, { uri: document.uri, version: document.version, offset: 0, program: parse('SELECT 1').program }, [whole]);
        expect(entriesOf(advice)).toHaveLength(0);
    });

    it('refuses to place findings against text that has already moved on', () => {
        // Positions were worked out against the version that ran. Drawing them
        // on a newer one underlines the wrong words, confidently.
        const advice = new AdviceDiagnostics();
        const { document } = docAt('SELECT uniqExact(user_id) FROM events');

        advice.show(document, { uri: document.uri, version: document.version + 1, offset: 0, program: parse(document.getText()).program }, [finding]);
        expect(entriesOf(advice)).toHaveLength(0);
    });
});
