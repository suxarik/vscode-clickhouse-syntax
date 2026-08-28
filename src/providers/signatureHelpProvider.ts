/**
 * Signature help for ClickHouse functions.
 *
 * The enclosing call is found through the token stream, so a parenthesis inside
 * a string literal or comment cannot throw the search off, and parameterised
 * aggregates such as `quantile(0.5)(x)` resolve to the right function.
 */
import * as vscode from 'vscode';
import { Catalog } from '../catalog';
import { resolveFunction } from '../functionInfo';
import { Token, TokenKind, tokenize, isTrivia } from '../lexer';
import { findKeywordTokens } from '../keywords';

interface CallSite {
    name: string;
    /** Number of top-level commas between the opening paren and the cursor. */
    activeParameter: number;
}

export function findCallSite(text: string, offset: number): CallSite | null {
    const all = tokenize(text);
    const keywords = findKeywordTokens(all);

    // Significant tokens strictly before the cursor, keeping their original index
    // so keyword classification still applies.
    const before: Token[] = [];
    const isKeywordToken: boolean[] = [];
    for (let i = 0; i < all.length; i++) {
        const token = all[i];
        if (isTrivia(token)) continue;
        if (token.end > offset) break;
        before.push(token);
        isKeywordToken.push(keywords.has(i));
    }
    if (before.length === 0) return null;

    // Innermost unclosed '('.
    let depth = 0;
    let openIndex = -1;
    for (let i = before.length - 1; i >= 0; i--) {
        const t = before[i];
        if (t.kind !== TokenKind.Punct) continue;
        if (t.text === ')') depth++;
        else if (t.text === '(') {
            if (depth === 0) {
                openIndex = i;
                break;
            }
            depth--;
        }
    }
    if (openIndex <= 0) return null;

    // The name in front of the paren, stepping over a parameter list first.
    let nameIndex = openIndex - 1;
    if (before[nameIndex].kind === TokenKind.Punct && before[nameIndex].text === ')') {
        let inner = 0;
        let i = nameIndex;
        for (; i >= 0; i--) {
            const t = before[i];
            if (t.kind !== TokenKind.Punct) continue;
            if (t.text === ')') inner++;
            else if (t.text === '(') {
                inner--;
                if (inner === 0) break;
            }
        }
        nameIndex = i - 1;
    }
    if (nameIndex < 0) return null;

    const nameToken = before[nameIndex];
    if (nameToken.kind !== TokenKind.Word) return null;
    // `SELECT (`, `IN (`, `OVER (` open a group, not a function call.
    if (isKeywordToken[nameIndex]) return null;

    let commas = 0;
    let inner = 0;
    for (let i = openIndex + 1; i < before.length; i++) {
        const t = before[i];
        if (t.kind !== TokenKind.Punct) continue;
        if (t.text === '(' || t.text === '[') inner++;
        else if (t.text === ')' || t.text === ']') inner--;
        else if (t.text === ',' && inner === 0) commas++;
    }

    return { name: nameToken.text, activeParameter: commas };
}

/**
 * Split a signature's parameter list, respecting nesting.
 *
 * Optional groups are written `f(a[, b])` in ClickHouse's syntax strings; the
 * brackets are unwrapped so `b` shows up as its own parameter, and the varargs
 * marker is dropped.
 */
export function signatureParameters(signature: string): string[] {
    const open = signature.indexOf('(');
    if (open < 0) return [];

    let depth = 0;
    let brackets = 0;
    let current = '';
    const params: string[] = [];

    const flush = () => {
        const trimmed = current.trim().replace(/^\[|\]$/g, '').trim();
        if (trimmed && trimmed !== '...') params.push(trimmed);
        current = '';
    };

    for (let i = open; i < signature.length; i++) {
        const c = signature[i];
        if (c === '(') {
            depth++;
            if (depth === 1) continue;
        } else if (c === ')') {
            depth--;
            if (depth === 0) break;
        } else if (c === '[' && depth === 1) {
            // Unwrap the optional group rather than treating it as one parameter.
            brackets++;
            continue;
        } else if (c === ']' && depth === 1 && brackets > 0) {
            brackets--;
            continue;
        }
        if (c === ',' && depth === 1) {
            flush();
            continue;
        }
        current += c;
    }
    flush();
    return params;
}

export async function buildSignatureHelp(
    text: string,
    offset: number,
    catalog: Catalog
): Promise<vscode.SignatureHelp | undefined> {
    const call = findCallSite(text, offset);
    if (!call) return undefined;

    const fn = await resolveFunction(call.name, catalog);
    if (!fn?.signature) return undefined;

    const help = new vscode.SignatureHelp();
    const signature = new vscode.SignatureInformation(
        fn.signature,
        new vscode.MarkdownString(fn.description ?? '')
    );

    // Prefer the catalog's documented argument names; fall back to parsing the
    // signature when the two disagree about how many parameters there are.
    const documented = fn.args?.map(arg => arg.name) ?? [];
    const parsed = signatureParameters(fn.signature);
    const names = documented.length === parsed.length && documented.length > 0 ? documented : parsed;
    if (names.length === 0) return undefined;

    for (const param of names) {
        const doc = fn.args?.find(arg => arg.name === param)?.description;
        signature.parameters.push(
            new vscode.ParameterInformation(param, doc ? new vscode.MarkdownString(doc) : undefined)
        );
    }

    help.signatures = [signature];
    help.activeSignature = 0;
    help.activeParameter = Math.min(call.activeParameter, Math.max(0, signature.parameters.length - 1));
    return help;
}

export function registerSignatureHelpProvider(catalog: Catalog): vscode.Disposable {
    return vscode.languages.registerSignatureHelpProvider(
        [{ language: 'clickhouse' }, { language: 'sql' }],
        {
            async provideSignatureHelp(
                document: vscode.TextDocument,
                position: vscode.Position
            ): Promise<vscode.SignatureHelp | undefined> {
                const config = vscode.workspace.getConfiguration('clickhouse');
                if (!config.get<boolean>('signatureHelp.enabled', true)) return undefined;
                try {
                    return await buildSignatureHelp(document.getText(), document.offsetAt(position), catalog);
                } catch (err) {
                    console.error('ClickHouse: signature help failed', err);
                    return undefined;
                }
            },
        },
        '(',
        ','
    );
}
