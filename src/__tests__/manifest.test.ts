/**
 * Tests for the extension manifest.
 *
 * A broken contribution does not fail the build or any other test - it fails
 * silently in the editor, where a walkthrough step points at a command that no
 * longer exists or a markdown file that was never packaged. These are the
 * checks a compiler would make if package.json were code.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

interface Manifest {
    contributes: {
        commands: Array<{ command: string; title: string; category?: string }>;
        menus: Record<string, Array<{ command?: string; when?: string }>>;
        walkthroughs?: Array<{
            id: string;
            title: string;
            description: string;
            steps: Array<{
                id: string;
                title: string;
                description: string;
                media: { markdown?: string; image?: string };
                completionEvents?: string[];
            }>;
        }>;
        viewsWelcome?: Array<{ view: string; contents: string }>;
        configuration?: { properties: Record<string, unknown> };
    };
}

const root = path.resolve(__dirname, '../..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as Manifest;
const commandIds = new Set(manifest.contributes.commands.map(entry => entry.command));

/** Every `command:…` link inside a markdown-ish string. */
function commandLinks(text: string): string[] {
    return [...text.matchAll(/\(command:([\w.]+)\)/g)].map(match => match[1]);
}

describe('contributed commands', () => {
    it('are all under the clickhouse namespace and titled consistently', () => {
        for (const entry of manifest.contributes.commands) {
            expect(entry.command).toMatch(/^clickhouse\./);
            expect(entry.title.length).toBeGreaterThan(0);
        }
    });

    it('are unique', () => {
        const ids = manifest.contributes.commands.map(entry => entry.command);
        expect(ids.length).toBe(new Set(ids).size);
    });

    it('are only referenced by menus that exist', () => {
        for (const [menu, items] of Object.entries(manifest.contributes.menus)) {
            for (const item of items) {
                if (!item.command) continue;
                expect({ menu, command: item.command, known: commandIds.has(item.command) }).toMatchObject({
                    known: true,
                });
            }
        }
    });
});

describe('the welcome content', () => {
    it('only offers commands that exist', () => {
        for (const welcome of manifest.contributes.viewsWelcome ?? []) {
            for (const command of commandLinks(welcome.contents)) {
                expect({ view: welcome.view, command, known: commandIds.has(command) }).toMatchObject({
                    known: true,
                });
            }
        }
    });
});

describe('the first-run walkthrough', () => {
    const walkthrough = manifest.contributes.walkthroughs?.[0];

    it('exists, with steps', () => {
        expect(walkthrough).toBeDefined();
        expect(walkthrough!.steps.length).toBeGreaterThan(0);
    });

    it('has a markdown file on disk for every step', () => {
        for (const step of walkthrough!.steps) {
            const markdown = step.media.markdown;
            expect({ step: step.id, markdown }).toMatchObject({ markdown: expect.any(String) });
            expect({ step: step.id, exists: fs.existsSync(path.join(root, markdown!)) }).toMatchObject({
                exists: true,
            });
        }
    });

    it('ships those files rather than leaving the steps blank', () => {
        // .vscodeignore decides what is in the .vsix; a step whose media is
        // excluded renders as an empty panel.
        const ignore = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8');
        const patterns = ignore
            .split('\n')
            .map(line => line.trim())
            .filter(line => line && !line.startsWith('#'));
        for (const step of walkthrough!.steps) {
            const directory = path.dirname(step.media.markdown!);
            expect(patterns).not.toContain(`${directory}/**`);
        }
    });

    it('only links commands that exist', () => {
        for (const step of walkthrough!.steps) {
            for (const command of commandLinks(step.description)) {
                // Built-in workbench commands are not ours to declare.
                if (!command.startsWith('clickhouse.')) continue;
                expect({ step: step.id, command, known: commandIds.has(command) }).toMatchObject({ known: true });
            }
        }
    });

    it('completes each step on something that actually happens', () => {
        for (const step of walkthrough!.steps) {
            expect({ step: step.id, events: step.completionEvents }).toMatchObject({
                events: expect.arrayContaining([expect.any(String)]),
            });
            for (const event of step.completionEvents!) {
                const [kind, value] = event.split(':');
                expect(['onCommand', 'onContext', 'onSettingChanged', 'onLink', 'onView']).toContain(kind);
                if (kind === 'onCommand' && value.startsWith('clickhouse.')) {
                    expect({ step: step.id, command: value, known: commandIds.has(value) }).toMatchObject({
                        known: true,
                    });
                }
            }
        }
    });

    it('has unique step ids', () => {
        const ids = walkthrough!.steps.map(step => step.id);
        expect(ids.length).toBe(new Set(ids).size);
    });
});

describe('contributed settings', () => {
    it('are all under the clickhouse namespace', () => {
        for (const key of Object.keys(manifest.contributes.configuration?.properties ?? {})) {
            expect(key).toMatch(/^clickhouse\./);
        }
    });

    it('describe themselves, so the settings UI is not a list of blanks', () => {
        for (const [key, value] of Object.entries(manifest.contributes.configuration?.properties ?? {})) {
            const described = value as { description?: string; markdownDescription?: string };
            expect({ key, described: Boolean(described.description ?? described.markdownDescription) }).toMatchObject(
                { described: true }
            );
        }
    });
});
