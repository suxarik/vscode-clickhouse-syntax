/**
 * Tests for signature help.
 */
import * as vscode from 'vscode';
import { buildSignatureHelp, findCallSite, signatureParameters } from '../providers/signatureHelpProvider';
import { makeCatalog } from './helpers';

/** Call site at the `|` marker. */
function callAt(sql: string) {
    const offset = sql.indexOf('|');
    return findCallSite(sql.replace('|', ''), offset);
}

describe('findCallSite', () => {
    it('finds the enclosing call', () => {
        expect(callAt('SELECT count(|)')).toEqual({ name: 'count', activeParameter: 0 });
    });

    it('counts the active parameter', () => {
        expect(callAt('SELECT substring(s, 1, |)')?.activeParameter).toBe(2);
    });

    it('ignores commas nested in an inner call', () => {
        expect(callAt('SELECT concat(toString(a, b), |)')?.activeParameter).toBe(1);
    });

    it('ignores commas inside array literals', () => {
        expect(callAt('SELECT arrayMap(x -> x, [1, 2, 3], |)')?.activeParameter).toBe(2);
    });

    it('reports the innermost call', () => {
        expect(callAt('SELECT concat(a, toString(|))')?.name).toBe('toString');
    });

    it('resolves a parameterised aggregate', () => {
        expect(callAt('SELECT quantile(0.5)(|)')?.name).toBe('quantile');
        expect(callAt('SELECT topK(5)(user_id, |)')).toEqual({ name: 'topK', activeParameter: 1 });
    });

    it('is not confused by a paren inside a string', () => {
        expect(callAt("SELECT count('(') , sum(|)")?.name).toBe('sum');
    });

    it('is not confused by a paren inside a comment', () => {
        expect(callAt('SELECT /* count( */ sum(|)')?.name).toBe('sum');
    });

    it('returns null outside any call', () => {
        expect(callAt('SELECT a |FROM t')).toBeNull();
    });

    it('returns null for a bare group', () => {
        expect(callAt('SELECT (|)')).toBeNull();
    });
});

describe('signatureParameters', () => {
    it('splits a simple signature', () => {
        expect(signatureParameters('substring(s, offset[, length])')).toEqual(['s', 'offset', 'length']);
    });

    it('splits a plain two-argument signature', () => {
        expect(signatureParameters('argMin(arg, val)')).toEqual(['arg', 'val']);
    });

    it('handles a no-argument signature', () => {
        expect(signatureParameters('now()')).toEqual([]);
    });

    it('keeps nested calls intact', () => {
        expect(signatureParameters('f(g(a, b), c)')).toEqual(['g(a, b)', 'c']);
    });

    it('returns nothing without a paren', () => {
        expect(signatureParameters('noparens')).toEqual([]);
    });
});

describe('buildSignatureHelp', () => {
    const catalog = makeCatalog();

    /** Signature help at the `|` marker. */
    async function helpAt(sql: string) {
        const offset = sql.indexOf('|');
        return buildSignatureHelp(sql.replace('|', ''), offset, catalog);
    }

    it('documents a curated function', async () => {
        const help = await helpAt('SELECT count(|)');
        expect(help!.signatures[0].label).toBe('count([expr])');
    });

    it('documents a function only the catalog knows', async () => {
        const help = await helpAt('SELECT toStartOfFifteenMinutes(|)');
        expect(help!.signatures[0].label).toContain('toStartOfFifteenMinutes');
    });

    it('names the parameters from the catalog', async () => {
        const help = await helpAt('SELECT arrayMap(|)');
        expect(help!.signatures[0].parameters.map((p: vscode.ParameterInformation) => p.label)).toEqual(['func', 'arr']);
    });

    it('expands optional parameter groups', async () => {
        const help = await helpAt('SELECT substring(|)');
        expect(help!.signatures[0].parameters.map((p: vscode.ParameterInformation) => p.label)).toEqual(['s', 'offset', 'length']);
    });

    it('tracks the active parameter', async () => {
        const help = await helpAt('SELECT substring(s, 1, |)');
        expect(help!.activeParameter).toBe(2);
    });

    it('clamps the active parameter to the parameter count', async () => {
        const help = await helpAt('SELECT count(a, b, c, d, |)');
        expect(help!.activeParameter).toBeLessThanOrEqual(help!.signatures[0].parameters.length);
    });

    it('returns nothing for an unknown function', async () => {
        expect(await helpAt('SELECT definitely_not_a_function(|)')).toBeUndefined();
    });

    it('returns nothing outside a call', async () => {
        expect(await helpAt('SELECT a |FROM t')).toBeUndefined();
    });
});
