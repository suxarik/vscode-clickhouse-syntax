/**
 * Colour for the plan view.
 *
 * The panel takes its colours from the editor's own theme, because a view that
 * ignores the user's theme does not look bold inside an IDE, it looks broken.
 * So the one expressive decision is not the hue but the encoding: how much work
 * a step did drives how strongly it is painted, and time spent *waiting* is
 * drawn as a hatch rather than another colour, because waiting is different in
 * kind from working, not merely different in degree.
 *
 * Values are resolved to literal rgba once, rather than left as `var(--…)`, so
 * the same drawing can be written to a file that has no theme at all.
 */

export interface Palette {
    foreground: string;
    muted: string;
    surface: string;
    border: string;
    accent: string;
    hot: string;
    background: string;
}

/** `#rgb`, `#rrggbb` or an `rgb()` string, to `r, g, b`. */
export function toRgbTriplet(color: string, fallback = '128, 128, 128'): string {
    const value = color.trim();
    if (!value) return fallback;

    const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (hex) {
        const digits = hex[1];
        const pairs =
            digits.length === 3
                ? [...digits].map(character => character + character)
                : [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 6)];
        return pairs.map(pair => parseInt(pair, 16)).join(', ');
    }

    const rgb = value.match(/rgba?\(\s*([0-9.]+)[\s,]+([0-9.]+)[\s,]+([0-9.]+)/i);
    if (rgb) return `${Math.round(+rgb[1])}, ${Math.round(+rgb[2])}, ${Math.round(+rgb[3])}`;

    return fallback;
}

export function withAlpha(color: string, alpha: number): string {
    return `rgba(${toRgbTriplet(color)}, ${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
}

/**
 * How strongly to paint a step, from its share of the query's CPU.
 *
 * Square-rooted so the small steps stay visible instead of fading to nothing,
 * while the expensive one still clearly dominates. The floor is what keeps a
 * 0.1% step readable rather than invisible.
 */
export function heatAlpha(share: number): number {
    const bounded = Math.max(0, Math.min(1, share));
    return 0.2 + 0.75 * Math.sqrt(bounded);
}

function cssValue(styles: CSSStyleDeclaration, name: string, fallback: string): string {
    const value = styles.getPropertyValue(name).trim();
    return value || fallback;
}

/** Resolve the theme once, into literal colours. */
export function readPalette(element: Element = document.documentElement): Palette {
    const styles = getComputedStyle(element);
    return {
        foreground: cssValue(styles, '--vscode-foreground', '#cccccc'),
        muted: cssValue(styles, '--vscode-descriptionForeground', '#9d9d9d'),
        surface: cssValue(styles, '--vscode-editorWidget-background', '#252526'),
        border: cssValue(styles, '--vscode-panel-border', '#454545'),
        accent: cssValue(styles, '--vscode-charts-blue', '#3794ff'),
        hot: cssValue(styles, '--vscode-charts-orange', '#d18616'),
        background: cssValue(styles, '--vscode-editor-background', '#1e1e1e'),
    };
}
