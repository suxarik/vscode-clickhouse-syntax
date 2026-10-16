/**
 * @jest-environment jsdom
 */
import { heatAlpha, heatColor, toRgbTriplet, withAlpha, readPalette } from '../explain/view/palette';

describe('toRgbTriplet', () => {
    it('reads a six digit hex colour', () => {
        expect(toRgbTriplet('#3794ff')).toBe('55, 148, 255');
    });

    it('reads the shorthand a theme may use', () => {
        expect(toRgbTriplet('#abc')).toBe('170, 187, 204');
    });

    it('reads an rgb string, which is what some themes resolve to', () => {
        expect(toRgbTriplet('rgb(18, 52, 86)')).toBe('18, 52, 86');
    });

    it('falls back rather than producing a broken colour', () => {
        expect(toRgbTriplet('')).toBe('128, 128, 128');
        expect(toRgbTriplet('not-a-colour')).toBe('128, 128, 128');
    });
});

describe('withAlpha', () => {
    it('keeps the colour and sets the transparency', () => {
        expect(withAlpha('#3794ff', 0.5)).toBe('rgba(55, 148, 255, 0.500)');
    });

    it('will not emit an out-of-range alpha', () => {
        expect(withAlpha('#000000', 5)).toContain('1.000');
        expect(withAlpha('#000000', -1)).toContain('0.000');
    });
});

describe('heatAlpha', () => {
    it('paints a heavier step more strongly', () => {
        expect(heatAlpha(0.7)).toBeGreaterThan(heatAlpha(0.1));
    });

    it('keeps a negligible step visible', () => {
        expect(heatAlpha(0.0001)).toBeGreaterThan(0.15);
    });

    it('stays within what a colour can express', () => {
        expect(heatAlpha(1)).toBeLessThanOrEqual(1);
        expect(heatAlpha(0)).toBeGreaterThanOrEqual(0);
    });
});

describe('readPalette', () => {
    it('falls back to readable colours when no theme is present', () => {
        const palette = readPalette();
        expect(palette.background).toMatch(/^#|rgb/);
        expect(palette.accent).toMatch(/^#|rgb/);
    });
});


describe('heatColor', () => {
    const channels = (color: string): number[] =>
        (color.match(/[0-9.]+/g) ?? []).slice(0, 3).map(Number);

    it('runs from yellow through orange to red as a step costs more', () => {
        const [, , coolBlue] = channels(heatColor(0));
        const [hotRed, hotGreen] = channels(heatColor(1));

        // Cheap steps keep yellow's blue channel low but its green high;
        // expensive ones lose the green entirely and end up red.
        expect(channels(heatColor(0))[1]).toBeGreaterThan(hotGreen);
        expect(hotRed).toBeGreaterThan(coolBlue);
    });

    it('gets stronger as the share grows, never weaker', () => {
        const alphaOf = (share: number): number => Number((heatColor(share).match(/[0-9.]+/g) ?? [])[3]);
        expect(alphaOf(0.8)).toBeGreaterThan(alphaOf(0.4));
        expect(alphaOf(0.4)).toBeGreaterThan(alphaOf(0.02));
    });

    it('stays a usable colour at both ends', () => {
        for (const share of [0, 0.5, 1, 2, -1]) {
            expect(heatColor(share)).toMatch(/^rgba\(\d+, \d+, \d+, [0-9.]+\)$/);
        }
    });
});
