/**
 * Tests for ClickHouse dialect detection.
 */
import * as vscode from 'vscode';
import { LanguageDetector } from '../languageDetection';
import { docAt } from './helpers';

const CH_SQL = 'SELECT * FROM t PREWHERE x = 1';
const PLAIN_SQL = 'SELECT * FROM users';

interface Harness {
    detector: LanguageDetector;
    state: Record<string, unknown>;
}

function makeDetector(config: Record<string, unknown> = {}): Harness {
    (vscode as unknown as { __setConfig(v: Record<string, unknown>): void }).__setConfig(config);
    const state: Record<string, unknown> = {};
    const context = {
        subscriptions: [],
        workspaceState: {
            get: (key: string, fallback: unknown) => (key in state ? state[key] : fallback),
            update: async (key: string, value: unknown) => {
                state[key] = value;
            },
        },
    } as unknown as vscode.ExtensionContext;
    return { detector: new LanguageDetector(context), state };
}

beforeEach(() => {
    jest.clearAllMocks();
    (vscode as unknown as { __resetConfig(): void }).__resetConfig();
    (vscode.window as unknown as { activeTextEditor: unknown }).activeTextEditor = undefined;
});

describe('detection modes', () => {
    it('does nothing when detection is off', async () => {
        const { detector } = makeDetector({ 'detect.mode': 'off' });
        const { document } = docAt(CH_SQL, 'sql');
        await detector.consider(document);
        expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
        expect(vscode.languages.setTextDocumentLanguage).not.toHaveBeenCalled();
        detector.dispose();
    });

    it('switches without asking in auto mode', async () => {
        const { detector } = makeDetector({ 'detect.mode': 'auto' });
        const { document } = docAt(CH_SQL, 'sql');
        await detector.consider(document);
        expect(vscode.languages.setTextDocumentLanguage).toHaveBeenCalledWith(document, 'clickhouse');
        expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
        detector.dispose();
    });

    it('asks first in prompt mode', async () => {
        const { detector } = makeDetector({ 'detect.mode': 'prompt' });
        (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue(undefined);
        const { document } = docAt(CH_SQL, 'sql');
        await detector.consider(document);
        expect(vscode.window.showInformationMessage).toHaveBeenCalled();
        expect(vscode.languages.setTextDocumentLanguage).not.toHaveBeenCalled();
        detector.dispose();
    });

    it('prompts by default', async () => {
        const { detector } = makeDetector();
        (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue(undefined);
        const { document } = docAt(CH_SQL, 'sql');
        await detector.consider(document);
        expect(vscode.window.showInformationMessage).toHaveBeenCalled();
        detector.dispose();
    });
});

describe('candidate selection', () => {
    it('ignores files that are already ClickHouse', async () => {
        const { detector } = makeDetector({ 'detect.mode': 'auto' });
        const { document } = docAt(CH_SQL, 'clickhouse');
        await detector.consider(document);
        expect(vscode.languages.setTextDocumentLanguage).not.toHaveBeenCalled();
        detector.dispose();
    });

    it('ignores plain SQL with no ClickHouse syntax', async () => {
        const { detector } = makeDetector({ 'detect.mode': 'auto' });
        const { document } = docAt(PLAIN_SQL, 'sql');
        await detector.consider(document);
        expect(vscode.languages.setTextDocumentLanguage).not.toHaveBeenCalled();
        detector.dispose();
    });

    it('leaves plain text alone unless opted in', async () => {
        const { detector } = makeDetector({ 'detect.mode': 'auto' });
        const { document } = docAt(CH_SQL, 'plaintext');
        await detector.consider(document);
        expect(vscode.languages.setTextDocumentLanguage).not.toHaveBeenCalled();
        detector.dispose();
    });

    it('considers plain text when opted in', async () => {
        const { detector } = makeDetector({ 'detect.mode': 'auto', 'detect.includePlaintext': true });
        const { document } = docAt(CH_SQL, 'plaintext');
        await detector.consider(document);
        expect(vscode.languages.setTextDocumentLanguage).toHaveBeenCalled();
        detector.dispose();
    });
});

describe('remembered decisions', () => {
    it('applies the switch after the user accepts', async () => {
        const { detector, state } = makeDetector({ 'detect.mode': 'prompt' });
        (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue('Switch');
        const { document } = docAt(CH_SQL, 'sql');
        await detector.consider(document);
        expect(vscode.languages.setTextDocumentLanguage).toHaveBeenCalledWith(document, 'clickhouse');
        expect(state['clickhouse.detect.decisions']).toEqual({ [document.uri.toString()]: 'accepted' });
        detector.dispose();
    });

    it('does not ask again after the user declines', async () => {
        const { detector } = makeDetector({ 'detect.mode': 'prompt' });
        (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue('Not this file');
        const { document } = docAt(CH_SQL, 'sql');

        await detector.consider(document);
        expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1);

        await detector.consider(document);
        expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1);
        expect(vscode.languages.setTextDocumentLanguage).not.toHaveBeenCalled();
        detector.dispose();
    });

    it('turns detection off globally on "Never ask"', async () => {
        const { detector } = makeDetector({ 'detect.mode': 'prompt' });
        (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue('Never ask');
        const { document } = docAt(CH_SQL, 'sql');
        await detector.consider(document);

        const config = (vscode.workspace.getConfiguration as jest.Mock).mock.results.at(-1)!.value;
        expect(config.update).toHaveBeenCalledWith('detect.mode', 'off', vscode.ConfigurationTarget.Global);
        detector.dispose();
    });

    it('does not prompt twice while a prompt is open', async () => {
        const { detector } = makeDetector({ 'detect.mode': 'prompt' });
        let resolvePrompt: (value: unknown) => void = () => undefined;
        (vscode.window.showInformationMessage as jest.Mock).mockReturnValue(
            new Promise(resolve => (resolvePrompt = resolve))
        );
        const { document } = docAt(CH_SQL, 'sql');

        const first = detector.consider(document);
        await detector.consider(document);
        expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1);

        resolvePrompt(undefined);
        await first;
        detector.dispose();
    });
});

describe('explicit commands', () => {
    it('switches on request', async () => {
        const { detector } = makeDetector();
        const { document } = docAt(CH_SQL, 'sql');
        (vscode.window as unknown as { activeTextEditor: unknown }).activeTextEditor = { document };
        await detector.detectExplicitly();
        expect(vscode.languages.setTextDocumentLanguage).toHaveBeenCalledWith(document, 'clickhouse');
        detector.dispose();
    });

    it('confirms before switching a file with no ClickHouse syntax', async () => {
        const { detector } = makeDetector();
        const { document } = docAt(PLAIN_SQL, 'sql');
        (vscode.window as unknown as { activeTextEditor: unknown }).activeTextEditor = { document };
        (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);

        await detector.detectExplicitly();
        expect(vscode.window.showWarningMessage).toHaveBeenCalled();
        expect(vscode.languages.setTextDocumentLanguage).not.toHaveBeenCalled();

        (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Switch anyway');
        await detector.detectExplicitly();
        expect(vscode.languages.setTextDocumentLanguage).toHaveBeenCalled();
        detector.dispose();
    });

    it('toggles back to plain SQL', async () => {
        const { detector, state } = makeDetector();
        const { document } = docAt(CH_SQL, 'clickhouse');
        (vscode.window as unknown as { activeTextEditor: unknown }).activeTextEditor = { document };
        await detector.toggleLanguage();
        expect(vscode.languages.setTextDocumentLanguage).toHaveBeenCalledWith(document, 'sql');
        expect(state['clickhouse.detect.decisions']).toEqual({ [document.uri.toString()]: 'declined' });
        detector.dispose();
    });
});

describe('status bar', () => {
    it('shows the ClickHouse mode for a ClickHouse document', () => {
        const { detector } = makeDetector();
        const item = (vscode.window.createStatusBarItem as jest.Mock).mock.results.at(-1)!.value;
        (vscode.window as unknown as { activeTextEditor: unknown }).activeTextEditor = {
            document: docAt(CH_SQL, 'clickhouse').document,
        };
        detector.updateStatusBar();
        expect(item.text).toContain('ClickHouse SQL');
        expect(item.show).toHaveBeenCalled();
        detector.dispose();
    });

    it('hides for unrelated languages', () => {
        const { detector } = makeDetector();
        const item = (vscode.window.createStatusBarItem as jest.Mock).mock.results.at(-1)!.value;
        (vscode.window as unknown as { activeTextEditor: unknown }).activeTextEditor = {
            document: docAt('print(1)', 'python').document,
        };
        detector.updateStatusBar();
        expect(item.hide).toHaveBeenCalled();
        detector.dispose();
    });
});
