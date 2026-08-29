/**
 * Reading what little is safe to read out of a Jinja tag.
 *
 * `{{ ref('users') }}` and `{{ source('raw', 'events') }}` are the two tags
 * worth understanding, because they name a relation and dbt records what that
 * relation resolves to. Everything else stays opaque: a tag can call a macro
 * that emits arbitrary SQL, and pretending otherwise would produce confident
 * wrong answers.
 */

export interface TemplateCall {
    call: 'ref' | 'source';
    arguments: string[];
}

/** `ref('a')`, `ref("a", "b")`, `source('s', 't')` - with dbt's own spacing. */
const CALL = /^\{\{-?\s*(ref|source)\s*\(([^)]*)\)\s*-?\}\}$/;
const ARGUMENT = /(['"])((?:\\.|(?!\1)[^\\])*)\1/g;

/**
 * The relation a tag names, or `undefined` if it does not name one plainly.
 *
 * A `ref` with a keyword argument, a variable, or anything other than string
 * literals returns `undefined` rather than a guess.
 */
export function readTemplateCall(text: string): TemplateCall | undefined {
    const match = CALL.exec(text.trim());
    if (!match) return undefined;

    const [, call, inside] = match;
    const args = [...inside.matchAll(ARGUMENT)].map(argument => argument[2]);
    if (args.length === 0) return undefined;

    // Every argument must be a plain string; `ref(var('x'))` is not resolvable.
    const consumed = inside.replace(ARGUMENT, '').replace(/[\s,]/g, '');
    if (consumed !== '') return undefined;

    return { call: call as 'ref' | 'source', arguments: args };
}

/** A readable stand-in for the tag, used as the node's name in the tree. */
export function templateLabel(text: string): string {
    const parsed = readTemplateCall(text);
    if (!parsed) return text.trim();
    return parsed.arguments.join('.');
}
