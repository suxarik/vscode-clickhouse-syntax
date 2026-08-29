/**
 * Runbook parameters: `{name:Type}` placeholders, filled in per notebook.
 *
 * A runbook is worth having because you re-run it - over yesterday, over the
 * other cluster, over the window the incident actually covers. Parameters are
 * what make that one prompt rather than a search and replace.
 *
 * Values are ClickHouse's own query parameters, sent as `param_<name>` and
 * substituted by the server with the declared type. They are never interpolated
 * into the SQL here, which is what keeps a date picked out of an input box from
 * being an injection. And they live for the session only: a window someone
 * looked at during an incident is not something to commit.
 */

export interface Parameter {
    name: string;
    /** The ClickHouse type declared in the placeholder. */
    type: string;
}

/**
 * `{name:Type}` - the same syntax `clickhouse-client --param_x` uses.
 *
 * Deliberately narrow: a name is an identifier and a type is a type
 * expression, so `{'a':1}` in a Map literal is not mistaken for a placeholder.
 */
const PLACEHOLDER = /\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([A-Za-z][A-Za-z0-9_]*(?:\([^{}()]*\))?)\s*\}/g;

/** String and comment spans, which are not places a placeholder can be. */
function codeOnly(sql: string): string {
    // Blanked rather than removed, so every offset still lines up.
    let out = '';
    let i = 0;
    while (i < sql.length) {
        const char = sql[i];
        if (char === "'" || char === '"' || char === '`') {
            const quote = char;
            out += ' ';
            i++;
            while (i < sql.length && sql[i] !== quote) {
                if (sql[i] === '\\') {
                    out += '  ';
                    i += 2;
                    continue;
                }
                out += ' ';
                i++;
            }
            if (i < sql.length) {
                out += ' ';
                i++;
            }
            continue;
        }
        if (char === '-' && sql[i + 1] === '-') {
            while (i < sql.length && sql[i] !== '\n') {
                out += ' ';
                i++;
            }
            continue;
        }
        if (char === '/' && sql[i + 1] === '*') {
            while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) {
                out += ' ';
                i++;
            }
            out += '  '.slice(0, Math.min(2, sql.length - i));
            i += 2;
            continue;
        }
        out += char;
        i++;
    }
    return out;
}

/** Every placeholder in a statement, in the order they appear, deduplicated. */
export function findParameters(sql: string): Parameter[] {
    const found = new Map<string, Parameter>();
    const code = codeOnly(sql);
    for (const match of code.matchAll(PLACEHOLDER)) {
        const [, name, type] = match;
        if (!found.has(name)) found.set(name, { name, type });
    }
    return [...found.values()];
}

/** A sensible starting value, so the prompt is not an empty box. */
export function suggestValue(type: string): string {
    const bare = type.replace(/\(.*\)$/, '');
    if (/^Date(Time(64)?)?$/.test(bare)) {
        const now = new Date();
        const date = now.toISOString().slice(0, 10);
        return bare === 'Date' ? date : `${date} 00:00:00`;
    }
    if (/^(U?Int\d*|Float\d*|Decimal)$/.test(bare)) return '0';
    if (/^Bool(ean)?$/.test(bare)) return 'true';
    if (/^Array$/.test(bare)) return '[]';
    return '';
}

/**
 * Remembered parameter values, per notebook.
 *
 * In memory only: closing the window forgets them, which is the same rule the
 * outputs follow and for the same reason.
 */
export class ParameterStore {
    private readonly byNotebook = new Map<string, Map<string, string>>();

    values(notebook: string): Record<string, string> {
        return Object.fromEntries(this.byNotebook.get(notebook) ?? []);
    }

    get(notebook: string, name: string): string | undefined {
        return this.byNotebook.get(notebook)?.get(name);
    }

    set(notebook: string, name: string, value: string): void {
        let values = this.byNotebook.get(notebook);
        if (!values) {
            values = new Map();
            this.byNotebook.set(notebook, values);
        }
        values.set(name, value);
    }

    /** Which of these parameters have no value yet. */
    missing(notebook: string, parameters: Parameter[]): Parameter[] {
        return parameters.filter(parameter => this.get(notebook, parameter.name) === undefined);
    }

    clear(notebook: string): void {
        this.byNotebook.delete(notebook);
    }

    forget(): void {
        this.byNotebook.clear();
    }
}
