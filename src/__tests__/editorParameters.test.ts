/**
 * Tests for `{name:Type}` placeholders in an ordinary editor.
 */
import * as vscode from 'vscode';
import { EditorParameters } from '../client/editorParameters';

const input = vscode.window.showInputBox as jest.Mock;

beforeEach(() => input.mockReset());

describe('EditorParameters', () => {
    it('asks for nothing when there is nothing to ask', async () => {
        expect(await new EditorParameters().resolve('SELECT 1')).toEqual({});
        expect(input).not.toHaveBeenCalled();
    });

    it('asks once per name, in order, and returns what was typed', async () => {
        input.mockResolvedValueOnce('2026-11-01').mockResolvedValueOnce('42');
        const values = await new EditorParameters().resolve(
            'SELECT * FROM t WHERE d >= {start:Date} AND id = {id:UInt64} AND d < {start:Date} + 1'
        );
        expect(values).toEqual({ start: '2026-11-01', id: '42' });
        expect(input).toHaveBeenCalledTimes(2);
        expect(input.mock.calls[0][0]).toMatchObject({ prompt: 'start · Date', title: 'Query parameter (1/2)' });
    });

    it('treats a dismissed prompt as a decision not to run', async () => {
        input.mockResolvedValueOnce('a').mockResolvedValueOnce(undefined);
        expect(await new EditorParameters().resolve('SELECT {a:String}, {b:String}')).toBeUndefined();
    });

    it('accepts an empty string as a value; only dismissing cancels', async () => {
        input.mockResolvedValueOnce('');
        expect(await new EditorParameters().resolve('SELECT {s:String}')).toEqual({ s: '' });
    });

    it('offers the last answer for a name, so repeating a query is Enter', async () => {
        const parameters = new EditorParameters();
        input.mockResolvedValueOnce('west');
        await parameters.resolve('SELECT {region:String}');
        input.mockResolvedValueOnce('west');
        await parameters.resolve('SELECT count() FROM t WHERE r = {region:String}');
        expect(input.mock.calls[1][0].value).toBe('west');

        parameters.forget();
        input.mockResolvedValueOnce('x');
        await parameters.resolve('SELECT {region:String}');
        expect(input.mock.calls[2][0].value).toBe('');
    });

    it('does not mistake a map literal or a comment for a placeholder', async () => {
        const sql = "SELECT {'a': 1}, '{x:String}' -- {y:String}";
        expect(await new EditorParameters().resolve(sql)).toEqual({});
        expect(input).not.toHaveBeenCalled();
    });
});
