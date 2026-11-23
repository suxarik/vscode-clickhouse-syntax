/**
 * `{name:Type}` placeholders in an ordinary editor.
 *
 * A runbook remembers its values for the session and asks once. An editor is the
 * opposite: the same query is run again and again with the value changed, so it
 * asks every time, with the last answer already in the box — Enter to repeat,
 * type to change.
 *
 * The values go to the server as ClickHouse's own query parameters, never into
 * the text, so a value typed into a box cannot become SQL.
 */
import * as vscode from 'vscode';
import { findParameters, suggestValue } from '../notebook/parameters';

export class EditorParameters {
    /** The last value for each name, for the session only. */
    private readonly last = new Map<string, string>();

    /**
     * Values for every placeholder in `sql`, `{}` when there are none, or
     * `undefined` when the prompt was dismissed — which is a decision not to
     * run, not a reason to send an unsubstituted query.
     */
    async resolve(sql: string): Promise<Record<string, string> | undefined> {
        const wanted = findParameters(sql);
        const values: Record<string, string> = {};

        for (const [index, parameter] of wanted.entries()) {
            const answer = await vscode.window.showInputBox({
                title: wanted.length > 1 ? `Query parameter (${index + 1}/${wanted.length})` : 'Query parameter',
                prompt: `${parameter.name} · ${parameter.type}`,
                value: this.last.get(parameter.name) ?? suggestValue(parameter.type),
                ignoreFocusOut: true,
            });
            if (answer === undefined) return undefined;
            values[parameter.name] = answer;
            this.last.set(parameter.name, answer);
        }
        return values;
    }

    forget(): void {
        this.last.clear();
    }
}

/** One for the window: Run, Explain and Analyze share what was last typed. */
export const editorParameters = new EditorParameters();
