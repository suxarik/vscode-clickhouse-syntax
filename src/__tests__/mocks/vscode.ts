/**
 * In-memory stand-in for the `vscode` module.
 *
 * Faithful enough for provider tests: documents honour ranges and offsets, and
 * configuration can be driven per test through `__setConfig`.
 */

export const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };

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
    RefactorRewrite: 'refactor.rewrite',
    Source: 'source',
};

export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
export const QuickPickItemKind = { Separator: -1, Default: 0 };
export const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 };
export const StatusBarAlignment = { Left: 1, Right: 2 };

export class MarkdownString {
    value: string;
    isTrusted = false;
    constructor(value = '') {
        this.value = value;
    }
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
    constructor(public contents: MarkdownString, public range?: unknown) {}
}

export class CompletionItem {
    insertText?: unknown;
    detail?: string;
    documentation?: MarkdownString;
    sortText?: string;
    constructor(public label: string, public kind?: number) {}
}

export class SnippetString {
    constructor(public value: string) {}
}

export class SignatureHelp {
    signatures: SignatureInformation[] = [];
    activeSignature = 0;
    activeParameter = 0;
}

export class SignatureInformation {
    parameters: ParameterInformation[] = [];
    constructor(public label: string, public documentation?: unknown) {}
}

export class ParameterInformation {
    constructor(public label: string, public documentation?: unknown) {}
}

export class Diagnostic {
    code?: string | number;
    source?: string;
    constructor(public range: Range, public message: string, public severity?: number) {}
}

export class CodeLens {
    constructor(public range: Range, public command?: unknown) {}
}

export class CodeAction {
    edit?: WorkspaceEdit;
    diagnostics?: Diagnostic[];
    command?: unknown;
    isPreferred?: boolean;
    constructor(public title: string, public kind?: unknown) {}
}

export class TextEdit {
    constructor(public range: Range, public newText: string) {}
    static replace(range: Range, newText: string): TextEdit {
        return new TextEdit(range, newText);
    }
}

export class WorkspaceEdit {
    edits: Array<{ uri: Uri; range: Range; newText: string }> = [];
    replace(uri: Uri, range: Range, newText: string): void {
        this.edits.push({ uri, range, newText });
    }
    insert(uri: Uri, position: Position, newText: string): void {
        this.edits.push({ uri, range: new Range(position, position), newText });
    }
}

export class Position {
    constructor(public line: number, public character: number) {}
}

export class Range {
    constructor(public start: Position, public end: Position) {}
    get isEmpty(): boolean {
        return this.start.line === this.end.line && this.start.character === this.end.character;
    }
    isEqual(other: Range): boolean {
        return comparePositions(this.start, other.start) === 0 && comparePositions(this.end, other.end) === 0;
    }
    contains(other: Range | Position): boolean {
        const start = other instanceof Range ? other.start : other;
        const end = other instanceof Range ? other.end : other;
        return comparePositions(this.start, start) <= 0 && comparePositions(this.end, end) >= 0;
    }
}

function comparePositions(a: Position, b: Position): number {
    return a.line - b.line || a.character - b.character;
}

export const SymbolKind = {
    File: 0, Module: 1, Namespace: 2, Package: 3, Class: 4, Method: 5, Property: 6,
    Field: 7, Constructor: 8, Enum: 9, Interface: 10, Function: 11, Variable: 12,
    Constant: 13, String: 14, Number: 15, Boolean: 16, Array: 17, Object: 18,
    Key: 19, Null: 20, EnumMember: 21, Struct: 22, Event: 23, Operator: 24,
    TypeParameter: 25,
};

export class DocumentSymbol {
    children: DocumentSymbol[] = [];
    constructor(
        public name: string,
        public detail: string,
        public kind: number,
        public range: Range,
        public selectionRange: Range
    ) {}
}

export const FoldingRangeKind = { Comment: 1, Imports: 2, Region: 3 };

export class FoldingRange {
    constructor(public start: number, public end: number, public kind?: number) {}
}

export class SelectionRange {
    constructor(public range: Range, public parent?: SelectionRange) {}
}

export class Location {
    constructor(public uri: Uri, public range: Range) {}
}

export const DocumentHighlightKind = { Text: 0, Read: 1, Write: 2 };

export class DocumentHighlight {
    constructor(public range: Range, public kind?: number) {}
}

export const InlayHintKind = { Type: 1, Parameter: 2 };

export class InlayHint {
    paddingLeft = false;
    paddingRight = false;
    constructor(public position: Position, public label: string, public kind?: number) {}
}

export class SemanticTokensLegend {
    constructor(public tokenTypes: string[], public tokenModifiers: string[]) {}
}

export class SemanticTokens {
    constructor(public data: Uint32Array) {}
}

/** Records pushes rather than encoding them, so tests can read them back. */
export class SemanticTokensBuilder {
    pushed: Array<{ line: number; char: number; length: number; type: number; modifiers: number }> = [];
    constructor(public legend?: SemanticTokensLegend) {}
    push(line: number, char: number, length: number, type: number, modifiers: number): void {
        this.pushed.push({ line, char, length, type, modifiers });
    }
    build(): SemanticTokens {
        const tokens = new SemanticTokens(new Uint32Array(this.pushed.length * 5));
        (tokens as unknown as { pushed: unknown }).pushed = this.pushed;
        return tokens;
    }
}

export class Selection extends Range {
    constructor(public anchor: Position, public active: Position) {
        super(anchor, active);
    }
}

export const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2 };

export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };

export class ThemeIcon {
    constructor(public id: string, public color?: unknown) {}
}

export class TreeItem {
    description?: string | boolean;
    tooltip?: string | MarkdownString;
    iconPath?: unknown;
    contextValue?: string;
    command?: unknown;
    constructor(public label: string, public collapsibleState?: number) {}
}

export class ThemeColor {
    constructor(public id: string) {}
}

/** Minimal event emitter with the same shape as the real one. */
export class EventEmitter<T> {
    private listeners: Array<(value: T) => void> = [];
    readonly event = (listener: (value: T) => void): Disposable => {
        this.listeners.push(listener);
        return new Disposable(() => {
            this.listeners = this.listeners.filter(entry => entry !== listener);
        });
    };
    fire(value: T): void {
        for (const listener of [...this.listeners]) listener(value);
    }
    dispose(): void {
        this.listeners = [];
    }
}

export class Disposable {
    constructor(private readonly callback?: () => void) {}
    dispose(): void {
        this.callback?.();
    }
}

export class Uri {
    private constructor(public readonly path: string) {}
    get fsPath(): string {
        return this.path;
    }
    get scheme(): string {
        return 'file';
    }
    toString(): string {
        return `file://${this.path}`;
    }
    static file(path: string): Uri {
        return new Uri(path);
    }
    static parse(path: string): Uri {
        return new Uri(path.replace(/^file:\/\//, ''));
    }
    static joinPath(base: Uri, ...segments: string[]): Uri {
        return new Uri([base.path, ...segments].join('/'));
    }
}

export class TextDocument {
    version = 1;
    constructor(private text: string, public languageId = 'clickhouse', public uri = Uri.file('/test/query.sql')) {}

    getText(range?: Range): string {
        if (!range) return this.text;
        return this.text.slice(this.offsetAt(range.start), this.offsetAt(range.end));
    }

    positionAt(offset: number): Position {
        const clamped = Math.max(0, Math.min(offset, this.text.length));
        const lines = this.text.slice(0, clamped).split('\n');
        return new Position(lines.length - 1, lines[lines.length - 1].length);
    }

    offsetAt(position: Position): number {
        const lines = this.text.split('\n');
        let offset = 0;
        for (let i = 0; i < position.line && i < lines.length; i++) offset += lines[i].length + 1;
        return offset + position.character;
    }

    lineAt(line: number): { text: string } {
        return { text: this.text.split('\n')[line] ?? '' };
    }

    getWordRangeAtPosition(position: Position, regex?: RegExp): Range | undefined {
        const line = this.lineAt(position.line).text;
        const pattern = new RegExp(regex?.source ?? '[a-zA-Z_][a-zA-Z0-9_]*', 'g');
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(line)) !== null) {
            const start = match.index;
            const end = start + match[0].length;
            if (start <= position.character && position.character <= end) {
                return new Range(new Position(position.line, start), new Position(position.line, end));
            }
        }
        return undefined;
    }
}

/** Values returned by `workspace.getConfiguration('clickhouse').get()`. */
let configValues: Record<string, unknown> = {};

export function __setConfig(values: Record<string, unknown>): void {
    configValues = values;
}

/**
 * What `update()` has written, per target.
 *
 * Kept separate from `configValues` so `inspect()` can answer "which settings
 * file does this profile live in?" - the question the edit and remove flows
 * turn on.
 */
const configByTarget: Record<number, Record<string, unknown>> = { 1: {}, 2: {} };

export function __resetConfig(): void {
    configValues = {};
    configByTarget[1] = {};
    configByTarget[2] = {};
}

/** Seed a value as though it were written to a particular settings file. */
export function __setConfigAt(target: number, key: string, value: unknown): void {
    configByTarget[target][key] = value;
    configValues[key] = value;
}

const disposable = () => ({ dispose: jest.fn() });

// ── Notebooks ────────────────────────────────────────────────────────────────

export const NotebookCellKind = { Markup: 1, Code: 2 };

export class NotebookCellData {
    metadata: unknown;
    outputs: unknown[] = [];
    executionSummary: unknown;
    constructor(
        public kind: number,
        public value: string,
        public languageId: string
    ) {}
}

export class NotebookData {
    metadata: unknown;
    constructor(public cells: NotebookCellData[]) {}
}

export class NotebookCellOutputItem {
    constructor(
        public data: Uint8Array,
        public mime: string
    ) {}
    static text(value: string, mime = 'text/plain') {
        return new NotebookCellOutputItem(new TextEncoder().encode(value), mime);
    }
    static json(value: unknown, mime = 'application/json') {
        return new NotebookCellOutputItem(new TextEncoder().encode(JSON.stringify(value)), mime);
    }
    static error(error: Error) {
        return new NotebookCellOutputItem(
            new TextEncoder().encode(JSON.stringify({ name: error.name, message: error.message })),
            'application/vnd.code.notebook.error'
        );
    }
}

export class NotebookCellOutput {
    constructor(
        public items: NotebookCellOutputItem[],
        public metadata?: unknown
    ) {}
}

/** Controllers created in a test, so it can drive them the way VS Code would. */
export const __notebookControllers: Record<string, unknown> = {};

export const notebooks = {
    createNotebookController: jest.fn((id: string, notebookType: string, label: string) => {
        const controller = {
            id,
            notebookType,
            label,
            description: '' as string | undefined,
            supportedLanguages: [] as string[],
            supportsExecutionOrder: false,
            executeHandler: undefined as unknown,
            interruptHandler: undefined as unknown,
            createNotebookCellExecution: jest.fn(),
            dispose: jest.fn(() => void delete __notebookControllers[id]),
        };
        __notebookControllers[id] = controller;
        return controller;
    }),
    createRendererMessaging: jest.fn(() => ({
        onDidReceiveMessage: jest.fn(disposable),
        postMessage: jest.fn(async () => true),
    })),
};

export const workspace = {
    registerNotebookSerializer: jest.fn(disposable),
    openNotebookDocument: jest.fn(async () => ({})),
    getConfiguration: jest.fn(() => ({
        get: jest.fn((key: string, defaultValue?: unknown) =>
            Object.prototype.hasOwnProperty.call(configValues, key) ? configValues[key] : defaultValue
        ),
        inspect: jest.fn((key: string) => ({
            key,
            globalValue: key in configByTarget[1] ? configByTarget[1][key] : configValues[key],
            workspaceValue: configByTarget[2][key],
        })),
        update: jest.fn(async (key: string, value: unknown, target?: number) => {
            configByTarget[target ?? 1][key] = value;
            configValues[key] = value;
        }),
    })),
    findFiles: jest.fn(async () => [] as Uri[]),
    fs: {
        readFile: jest.fn(),
        writeFile: jest.fn(),
        stat: jest.fn(),
        createDirectory: jest.fn(async () => undefined),
        delete: jest.fn(async () => undefined),
    },
    textDocuments: [] as TextDocument[],
    isTrusted: true,
    workspaceFolders: undefined as unknown,
    onDidChangeConfiguration: jest.fn(disposable),
    onDidOpenTextDocument: jest.fn(disposable),
    onDidCloseTextDocument: jest.fn(disposable),
    onDidSaveTextDocument: jest.fn(disposable),
    onDidChangeTextDocument: jest.fn(disposable),
    openTextDocument: jest.fn(),
    registerTextDocumentContentProvider: jest.fn(disposable),
    createFileSystemWatcher: jest.fn(() => ({
        onDidChange: jest.fn(disposable),
        onDidCreate: jest.fn(disposable),
        onDidDelete: jest.fn(disposable),
        dispose: jest.fn(),
    })),
};

/**
 * A quick pick that records its handlers, so a test can drive the picker the
 * way a person would: press a button, accept an item, dismiss it.
 */
export function makeQuickPick() {
    const handlers: Record<string, ((arg: never) => unknown)[]> = {};
    const on = (name: string) => (handler: (arg: never) => unknown) => {
        (handlers[name] ??= []).push(handler);
        return { dispose: jest.fn() };
    };
    const fire = async (name: string, arg?: unknown) => {
        for (const handler of handlers[name] ?? []) await handler(arg as never);
    };
    const picker = {
        placeholder: '',
        value: '',
        matchOnDetail: false,
        matchOnDescription: false,
        items: [] as unknown[],
        selectedItems: [] as unknown[],
        title: '' as string | undefined,
        buttons: [] as unknown[],
        show: jest.fn(),
        dispose: jest.fn(),
        hide: jest.fn(() => void fire('hide')),
        onDidTriggerItemButton: jest.fn(on('itemButton')),
        onDidAccept: jest.fn(on('accept')),
        onDidHide: jest.fn(on('hide')),
        onDidChangeValue: jest.fn(on('changeValue')),
        /** Test helpers: drive the picker the way a person would. */
        triggerItemButton: (item: unknown, button?: unknown) => fire('itemButton', { item, button }),
        accept: async (item?: unknown) => {
            if (item) picker.selectedItems = [item];
            await fire('accept');
        },
    };
    return picker;
}

export const window = {
    showInformationMessage: jest.fn(),
    showWarningMessage: jest.fn(),
    showTextDocument: jest.fn(),
    createOutputChannel: jest.fn(() => ({
        clear: jest.fn(),
        appendLine: jest.fn(),
        show: jest.fn(),
        dispose: jest.fn(),
    })),
    createStatusBarItem: jest.fn(() => ({
        text: '',
        tooltip: '',
        command: '',
        backgroundColor: undefined as unknown,
        show: jest.fn(),
        hide: jest.fn(),
        dispose: jest.fn(),
    })),
    showQuickPick: jest.fn(),
    createQuickPick: jest.fn(() => makeQuickPick()),
    showErrorMessage: jest.fn(),
    setStatusBarMessage: jest.fn(),
    showSaveDialog: jest.fn(),
    createWebviewPanel: jest.fn(() => ({
        title: '',
        webview: {
            html: '',
            cspSource: 'vscode-webview:',
            asWebviewUri: (uri: Uri) => uri,
            postMessage: jest.fn(async () => true),
            onDidReceiveMessage: jest.fn(disposable),
        },
        reveal: jest.fn(),
        onDidDispose: jest.fn(disposable),
        dispose: jest.fn(),
    })),
    showInputBox: jest.fn(),
    showNotebookDocument: jest.fn(async () => ({})),
    withProgress: jest.fn(async (_options: unknown, task: (p: unknown, t: unknown) => Promise<unknown>) =>
        task({ report: jest.fn() }, { isCancellationRequested: false, onCancellationRequested: jest.fn() })
    ),
    onDidChangeActiveTextEditor: jest.fn(disposable),
    registerTreeDataProvider: jest.fn(disposable),
    createTreeView: jest.fn(() => ({ message: undefined as string | undefined, dispose: jest.fn() })),
    activeTextEditor: undefined as unknown,
};

export const commands = {
    registerCommand: jest.fn(disposable),
    executeCommand: jest.fn(async () => undefined),
};

export const env = {
    clipboard: { writeText: jest.fn(async () => undefined), readText: jest.fn(async () => '') },
};

export const languages = {
    registerHoverProvider: jest.fn(disposable),
    registerCompletionItemProvider: jest.fn(disposable),
    registerSignatureHelpProvider: jest.fn(disposable),
    registerCodeActionsProvider: jest.fn(disposable),
    registerDocumentFormattingEditProvider: jest.fn(disposable),
    registerDocumentRangeFormattingEditProvider: jest.fn(disposable),
    registerDocumentSymbolProvider: jest.fn(disposable),
    registerFoldingRangeProvider: jest.fn(disposable),
    registerSelectionRangeProvider: jest.fn(disposable),
    registerDocumentSemanticTokensProvider: jest.fn(disposable),
    registerDefinitionProvider: jest.fn(disposable),
    registerReferenceProvider: jest.fn(disposable),
    registerRenameProvider: jest.fn(disposable),
    registerDocumentHighlightProvider: jest.fn(disposable),
    registerInlayHintsProvider: jest.fn(disposable),
    registerCodeLensProvider: jest.fn(disposable),
    createDiagnosticCollection: jest.fn(() => ({
        set: jest.fn(),
        delete: jest.fn(),
        dispose: jest.fn(),
    })),
    setTextDocumentLanguage: jest.fn(),
};
