/**
 * Mock for vscode module for unit testing.
 */

export const DiagnosticSeverity = {
    Error: 0,
    Warning: 1,
    Information: 2,
    Hint: 3,
};

export const CompletionItemKind = {
    Text: 0, Method: 1, Function: 2, Constructor: 3,
    Field: 4, Variable: 5, Class: 6, Interface: 7,
    Module: 8, Property: 9, Unit: 10, Value: 11,
    Enum: 12, Keyword: 13, Snippet: 14, Color: 15,
    File: 16, Reference: 17, Folder: 18, EnumMember: 19,
    Constant: 20, Struct: 21, Event: 22, Operator: 23,
    TypeParameter: 24,
};

export const CodeActionKind = {
    Empty: '',
    QuickFix: 'quickfix',
    Refactor: 'refactor',
    RefactorExtract: 'refactor.extract',
    RefactorInline: 'refactor.inline',
    RefactorRewrite: 'refactor.rewrite',
    Source: 'source',
    SourceOrganizeImports: 'source.organizeImports',
    SourceFixAll: 'source.fixAll',
};

export class MarkdownString {
    value = '';
    isTrusted = false;
    appendMarkdown(value: string): this {
        this.value += value;
        return this;
    }
    appendCodeblock(value: string, language?: string): this {
        this.value += '```' + (language || '') + '\n' + value + '\n```\n';
        return this;
    }
}

export class Hover {
    constructor(public contents: MarkdownString, public range?: any) {}
}

export class CompletionItem {
    insertText?: any;
    detail?: string;
    documentation?: MarkdownString;
    constructor(public label: string, public kind?: number) {}
}

export class SnippetString {
    constructor(public value: string) {}
}

export class SignatureHelp {
    signatures: any[] = [];
    activeSignature = 0;
    activeParameter = 0;
}

export class SignatureInformation {
    parameters: any[] = [];
    constructor(public label: string, public documentation?: any) {}
}

export class ParameterInformation {
    constructor(public label: string, public documentation?: any) {}
}

export class Diagnostic {
    constructor(
        public range: any,
        public message: string,
        public severity?: number,
        public code?: string | number,
    ) {}
}

export class CodeAction {
    edit?: any;
    diagnostics?: Diagnostic[];
    command?: any;
    isPreferred?: boolean;
    constructor(public title: string, public kind?: any) {}
}

export class TextEdit {
    constructor(public range: any, public newText: string) {}
    static replace(range: any, newText: string): TextEdit {
        return new TextEdit(range, newText);
    }
}

export class Range {
    constructor(
        public start: Position,
        public end: Position,
    ) {}
}

export class Position {
    constructor(
        public line: number,
        public character: number,
    ) {}
}

export class Uri {
    fsPath = '/test/path';
    static parse(path: string): Uri { return new Uri(); }
    static joinPath(base: Uri, ...pathSegments: string[]): Uri { return new Uri(); }
}

export class TextDocument {
    uri = new Uri();
    languageId = 'clickhouse';
    constructor(private text: string) {}
    getText(range?: Range): string {
        if (!range) return this.text;
        return this.text;
    }
    positionAt(offset: number): Position {
        const lines = this.text.slice(0, offset).split('\n');
        return new Position(lines.length - 1, lines[lines.length - 1].length);
    }
    offsetAt(position: Position): number {
        const lines = this.text.split('\n');
        let offset = 0;
        for (let i = 0; i < position.line; i++) {
            offset += lines[i].length + 1;
        }
        return offset + position.character;
    }
    lineAt(line: number): { text: string } {
        const lines = this.text.split('\n');
        return { text: lines[line] || '' };
    }
    getWordRangeAtPosition(position: Position, regex?: RegExp): Range | undefined {
        const line = this.lineAt(position.line).text;
        const r = regex || /[a-zA-Z_][a-zA-Z0-9_]*/g;
        let match;
        while ((match = r.exec(line)) !== null) {
            const start = match.index;
            const end = start + match[0].length;
            if (start <= position.character && position.character <= end) {
                return new Range(new Position(position.line, start), new Position(position.line, end));
            }
        }
        return undefined;
    }
}

export const workspace = {
    getConfiguration: jest.fn(() => ({
        get: jest.fn((key: string, defaultValue?: any) => defaultValue),
    })),
    findFiles: jest.fn(),
    fs: {
        readFile: jest.fn(),
        writeFile: jest.fn(),
    },
    workspaceFolders: undefined as any,
    onDidChangeConfiguration: jest.fn(() => ({ dispose: jest.fn() })),
    createFileSystemWatcher: jest.fn(() => ({
        onDidChange: jest.fn(() => ({ dispose: jest.fn() })),
        onDidCreate: jest.fn(() => ({ dispose: jest.fn() })),
        onDidDelete: jest.fn(() => ({ dispose: jest.fn() })),
        dispose: jest.fn(),
    })),
};

export const window = {
    showInformationMessage: jest.fn(),
    showWarningMessage: jest.fn(),
    showTextDocument: jest.fn(),
    activeTextEditor: undefined,
};

export const commands = {
    registerCommand: jest.fn(() => ({ dispose: jest.fn() })),
};

export const languages = {
    registerHoverProvider: jest.fn(() => ({ dispose: jest.fn() })),
    registerCompletionItemProvider: jest.fn(() => ({ dispose: jest.fn() })),
    registerSignatureHelpProvider: jest.fn(() => ({ dispose: jest.fn() })),
    registerCodeActionsProvider: jest.fn(() => ({ dispose: jest.fn() })),
    registerDocumentFormattingEditProvider: jest.fn(() => ({ dispose: jest.fn() })),
    registerDocumentRangeFormattingEditProvider: jest.fn(() => ({ dispose: jest.fn() })),
    createDiagnosticCollection: jest.fn(() => ({
        set: jest.fn(),
        delete: jest.fn(),
        dispose: jest.fn(),
    })),
    setTextDocumentLanguage: jest.fn(),
};
