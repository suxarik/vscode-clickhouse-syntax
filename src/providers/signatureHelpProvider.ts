/**
 * Signature help provider for ClickHouse SQL functions.
 */
import * as vscode from 'vscode';
import { CH_FUNCTION_DOCS } from '../functionDocs';

export function registerSignatureHelpProvider(): vscode.Disposable {
    return vscode.languages.registerSignatureHelpProvider(
        [{ language: 'clickhouse' }, { language: 'sql' }],
        {
            provideSignatureHelp(document: vscode.TextDocument, position: vscode.Position): vscode.SignatureHelp | undefined {
                const config = vscode.workspace.getConfiguration('clickhouse');
                if (!config.get<boolean>('signatureHelp.enabled', true)) return undefined;

                const text = document.getText();
                const offset = document.offsetAt(position);

                // Find the function call at the cursor position
                let parenDepth = 0;
                let funcStart = -1;
                let funcName = '';

                for (let i = offset - 1; i >= 0; i--) {
                    const char = text[i];
                    if (char === ')') parenDepth++;
                    if (char === '(') {
                        if (parenDepth === 0) {
                            funcStart = i;
                            break;
                        }
                        parenDepth--;
                    }
                }

                if (funcStart < 0) return undefined;

                // Extract function name
                const beforeParen = text.substring(0, funcStart).trim();
                const match = beforeParen.match(/([a-zA-Z_][a-zA-Z0-9_]*)\s*$/);
                if (match) {
                    funcName = match[1];
                }

                const funcInfo = CH_FUNCTION_DOCS[funcName.toLowerCase()];
                if (!funcInfo || !funcInfo.signature) return undefined;

                const signatureHelp = new vscode.SignatureHelp();
                const sigInfo = new vscode.SignatureInformation(
                    funcInfo.signature,
                    new vscode.MarkdownString(funcInfo.description)
                );

                // Try to extract parameters from signature
                const paramMatch = funcInfo.signature.match(/\((.*)\)/);
                if (paramMatch) {
                    const params = paramMatch[1].split(',').map(p => p.trim());
                    for (const param of params) {
                        sigInfo.parameters.push(new vscode.ParameterInformation(param));
                    }
                }

                signatureHelp.signatures = [sigInfo];
                signatureHelp.activeSignature = 0;

                // Calculate active parameter based on comma count
                let commaCount = 0;
                let innerDepth = 0;
                for (let i = funcStart + 1; i < offset; i++) {
                    const char = text[i];
                    if (char === '(') innerDepth++;
                    if (char === ')') innerDepth--;
                    if (char === ',' && innerDepth === 0) commaCount++;
                }
                signatureHelp.activeParameter = commaCount;

                return signatureHelp;
            }
        },
        '(', ','
    );
}
