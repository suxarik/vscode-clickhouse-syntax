/**
 * Tests for the shipped runbook templates.
 *
 * A template that fails on first use is worse than no template, so these check
 * the files themselves: that every one listed exists, parses into the cells it
 * claims, declares only parameters it uses, and reads only. The queries are
 * verified separately by running each file through a real clickhouse-client.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TEMPLATES } from '../notebook/templates';
import { parseCells, writeCells } from '../notebook/format';
import { findParameters } from '../notebook/parameters';
import { classifyStatement } from '../client/safety';
import { parse } from '../parser/parser';

const root = path.resolve(__dirname, '../..');
const read = (file: string) => fs.readFileSync(path.join(root, 'media', 'runbooks', file), 'utf8');

describe('every shipped template', () => {
    it.each(TEMPLATES.map(template => [template.label, template.file]))('%s exists', (_label, file) => {
        expect(fs.existsSync(path.join(root, 'media', 'runbooks', file))).toBe(true);
    });

    it.each(TEMPLATES.map(template => [template.label, template.file]))(
        '%s opens with prose before the first query',
        (_label, file) => {
            const cells = parseCells(read(file));
            expect(cells[0].kind).toBe('markup');
            // A runbook is prose and queries alternating, not a wall of SQL.
            expect(cells.filter(cell => cell.kind === 'markup').length).toBeGreaterThanOrEqual(3);
            expect(cells.filter(cell => cell.kind === 'code').length).toBeGreaterThanOrEqual(3);
        }
    );

    it.each(TEMPLATES.map(template => [template.label, template.file]))(
        '%s only reads, so it is safe on a read-only profile',
        (_label, file) => {
            for (const cell of parseCells(read(file))) {
                if (cell.kind !== 'code') continue;
                for (const statement of parse(cell.value).program.statements) {
                    const summary = classifyStatement(statement);
                    expect({ file, label: summary.label, effect: summary.effect }).toMatchObject({
                        effect: 'read',
                    });
                }
            }
        }
    );

    it.each(TEMPLATES.map(template => [template.label, template.file]))(
        '%s round-trips unchanged, so opening and saving it is a no-op',
        (_label, file) => {
            const text = read(file);
            expect(writeCells(parseCells(text))).toBe(text);
        }
    );

    it.each(TEMPLATES.map(template => [template.label, template.file]))(
        '%s explains every parameter it asks for',
        (_label, file) => {
            const text = read(file);
            const parameters = findParameters(text);
            const prose = parseCells(text)
                .filter(cell => cell.kind === 'markup')
                .map(cell => cell.value)
                .join('\n');
            for (const parameter of parameters) {
                // A prompt for `hours` should not be the first time the reader
                // hears about it.
                expect({ file, parameter: parameter.name, mentioned: prose.includes(parameter.name) }).toMatchObject(
                    { mentioned: true }
                );
            }
        }
    );

    it.each(TEMPLATES.map(template => [template.label, template.file]))(
        '%s ends every query but the last, so the file pipes to clickhouse-client',
        (_label, file) => {
            const cells = parseCells(read(file));
            const code = cells.filter(cell => cell.kind === 'code');
            for (const cell of code.slice(0, -1)) {
                expect({ file, value: cell.value.slice(-30) }).toMatchObject({
                    value: expect.stringMatching(/;$/),
                });
            }
        }
    );
});

describe('the template list', () => {
    it('describes each one well enough to choose between them', () => {
        for (const template of TEMPLATES) {
            expect(template.label.length).toBeGreaterThan(5);
            expect(template.detail.length).toBeGreaterThan(30);
            expect(template.file).toMatch(/\.runbook\.sql$/);
        }
    });

    it('lists nothing twice', () => {
        expect(new Set(TEMPLATES.map(t => t.file)).size).toBe(TEMPLATES.length);
    });

    it('leaves no file in the folder unlisted', () => {
        const onDisk = fs.readdirSync(path.join(root, 'media', 'runbooks'));
        expect(onDisk.sort()).toEqual(TEMPLATES.map(template => template.file).sort());
    });
});
