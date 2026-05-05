/**
 * SQL context detection helpers for ClickHouse queries.
 */
import * as vscode from 'vscode';
import { CH_DETECTION_PATTERNS } from './constants';

export function isClickHouseSQL(text: string): boolean {
    const sample = text.length > 8192 ? text.slice(0, 8192) : text;
    return CH_DETECTION_PATTERNS.some(re => re.test(sample));
}

export async function detectAndApplyLanguage(document: vscode.TextDocument): Promise<void> {
    if (document.languageId === 'clickhouse') return;
    if (!['sql', 'plaintext'].includes(document.languageId)) return;
    if (document.uri.scheme !== 'file') return;

    if (isClickHouseSQL(document.getText())) {
        try {
            await vscode.languages.setTextDocumentLanguage(document, 'clickhouse');
        } catch {
            // silently ignore
        }
    }
}

export function getSqlContext(document: vscode.TextDocument, position: vscode.Position): { clause: string; prevText: string } {
    const text = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
    const upperText = text.toUpperCase();

    const clauses = [
        'SELECT', 'FROM', 'WHERE', 'PREWHERE', 'GROUP BY', 'ORDER BY',
        'HAVING', 'LIMIT', 'LIMIT BY', 'JOIN', 'ON', 'USING',
        'INSERT INTO', 'VALUES', 'CREATE TABLE', 'ALTER TABLE',
        'SET', 'FORMAT', 'SETTINGS', 'WITH', 'AND', 'OR'
    ];

    let currentClause = '';
    for (const clause of clauses) {
        const regex = new RegExp(`\\b${clause.replace(/\s+/g, '\\s+')}\\b`, 'gi');
        let match;
        while ((match = regex.exec(upperText)) !== null) {
            currentClause = clause;
        }
    }

    return { clause: currentClause, prevText: text };
}

export function getWordBeforeCursor(document: vscode.TextDocument, position: vscode.Position): string {
    const lineText = document.lineAt(position.line).text;
    const beforeCursor = lineText.substring(0, position.character);
    const match = beforeCursor.match(/([a-zA-Z_][a-zA-Z0-9_]*)\s*$/);
    return match ? match[1] : '';
}

export function isAfterDot(document: vscode.TextDocument, position: vscode.Position): { isAfter: boolean; prefix: string } {
    const lineText = document.lineAt(position.line).text;
    const beforeCursor = lineText.substring(0, position.character);
    const match = beforeCursor.match(/([a-zA-Z_][a-zA-Z0-9_]*)\.\s*$/);
    return { isAfter: !!match, prefix: match ? match[1] : '' };
}

/**
 * Extract all table references from a SQL query text.
 */
export function extractTableReferences(text: string): Array<{ fullRef: string; database?: string; table: string }> {
    const refs: Array<{ fullRef: string; database?: string; table: string }> = [];
    const regex = /\bFROM\s+(\w+(?:\.\w+)?)|\bJOIN\s+(\w+(?:\.\w+)?)/gi;
    let match;
    while ((match = regex.exec(text)) !== null) {
        const fullRef = match[1] || match[2];
        const parts = fullRef.split('.');
        if (parts.length > 1) {
            refs.push({ fullRef, database: parts[0], table: parts[1] });
        } else {
            refs.push({ fullRef, table: parts[0] });
        }
    }
    return refs;
}

/**
 * Check if a query contains a specific clause.
 */
export function hasClause(text: string, clause: string): boolean {
    const regex = new RegExp(`\\b${clause.replace(/\s+/g, '\\s+')}\\b`, 'i');
    return regex.test(text);
}
