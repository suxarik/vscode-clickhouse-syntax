/**
 * Icons drawn for a webview.
 *
 * The explorer names codicons, which VS Code draws itself. A page has no access
 * to them without shipping the font and loosening its content policy, so each
 * one the explorer can pick for a table is drawn here as a small inline SVG
 * instead. Names are the same, so the two stay in step: `engineIcon` decides,
 * this only draws.
 */

const PATHS: Record<string, string> = {
    zap: '<path d="M9.2 1.5 3.5 9h4.2l-.9 5.5L12.5 7H8.3z"/>',
    eye: '<path d="M1.5 8s2.3-4.5 6.5-4.5S14.5 8 14.5 8s-2.3 4.5-6.5 4.5S1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>',
    book: '<path d="M3 2.5h8a2 2 0 0 1 2 2v9H5a2 2 0 0 1-2-2z"/><path d="M3 11.5a2 2 0 0 1 2-2h8"/>',
    'type-hierarchy': '<path d="M2 6.5h3v3H2zM11 2.5h3v3h-3zM11 10.5h3v3h-3z"/><path d="M5 8h3M8 4h3M8 12h3M8 4v8"/>',
    merge: '<circle cx="4" cy="3.5" r="1.5"/><circle cx="4" cy="12.5" r="1.5"/><circle cx="12" cy="8" r="1.5"/><path d="M4 5v6M4 5c0 2.5 8 1.2 8 1.5"/>',
    inbox: '<path d="M2 9.5 4 3h8l2 6.5V13H2z"/><path d="M2 9.5h3.5l.5 1.5h4l.5-1.5H14"/>',
    'circle-slash': '<circle cx="8" cy="8" r="6"/><path d="M3.8 12.2 12.2 3.8"/>',
    references: '<path d="M3.5 3.5h9v3h-9zM3.5 9.5h9v3h-9z"/>',
    versions: '<path d="M5.5 5.5h7v8h-7z"/><path d="M3.5 10.5v-8h7"/>',
    graph: '<path d="M3 13V8M7 13V3M11 13V6M14 13.5H2"/>',
    fold: '<path d="M8 2v3.5M5.5 4 8 6.5 10.5 4M8 14v-3.5M5.5 12 8 9.5l2.5 2.5"/>',
    'graph-line': '<path d="m2 12 4-5 3 3 5-6.5M2 14h12"/>',
    layers: '<path d="m8 2 6 3-6 3-6-3z"/><path d="m2 8 6 3 6-3M2 11l6 3 6-3"/>',
    'radio-tower':
        '<circle cx="8" cy="7" r="1"/><path d="M8 8v6M5.5 14h5M5 4.5a4 4 0 0 0 0 5M11 4.5a4 4 0 0 1 0 5M2.8 3a7 7 0 0 0 0 8M13.2 3a7 7 0 0 1 0 8"/>',
    cloud: '<path d="M4.5 12.5a3 3 0 0 1-.4-6A4 4 0 0 1 11.7 5.6a3.5 3.5 0 0 1-.2 6.9z"/>',
    plug: '<path d="M6 2v3M10 2v3M4.5 5h7v3a3.5 3.5 0 0 1-7 0zM8 11.5V14"/>',
    output: '<path d="M3 4h10M3 8h10M3 12h6"/>',
    table: '<path d="M2 3h12v10H2zM2 6.5h12M6.5 6.5V13"/>',
    search: '<circle cx="6.8" cy="6.8" r="4.3"/><path d="m10 10 4 4"/>',
    open: '<path d="M9 2.5h4.5V7M13.5 2.5l-6 6M12 9.5V13H3V4h3.5"/>',
    download: '<path d="M8 2v8M4.8 7 8 10.2 11.2 7M2.5 13.5h11"/>',
    clock: '<circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/>',
    warning: '<path d="M8 2 14.5 13.5h-13z"/><path d="M8 6.5v3.2M8 11.7v.1"/>',
    'chevron-left': '<path d="m10 3.5-4.5 4.5 4.5 4.5"/>',
    'chevron-right': '<path d="m6 3.5 4.5 4.5L6 12.5"/>',
    pulse: '<path d="M1.5 8h3l2-5 3 10 2-5h3"/>',
    refresh: '<path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3"/>',
    memory: '<path d="M4.5 4.5h7v7h-7zM6.5 2v2.5M9.5 2v2.5M6.5 11.5V14M9.5 11.5V14M2 6.5h2.5M2 9.5h2.5M11.5 6.5H14M11.5 9.5H14"/>',
    database:
        '<ellipse cx="8" cy="4" rx="5" ry="2"/><path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4M3 8c0 1.1 2.2 2 5 2s5-.9 5-2"/>',
    info: '<circle cx="8" cy="8" r="6"/><path d="M8 7.2v4M8 4.9v.1"/>',
    check: '<path d="m3 8.5 3.2 3.2L13 5"/>',
    edit: '<path d="m10.5 3 2.5 2.5-7.5 7.5H3v-2.5z"/>',
    server: '<path d="M2.5 3h11v4h-11zM2.5 9h11v4h-11zM5 5h.01M5 11h.01"/>',
    error: '<circle cx="8" cy="8" r="6"/><path d="M8 4.8v3.8M8 11v.1"/>',
};

/** What an icon stands for, which decides its colour. */
const TONES: Record<string, 'live' | 'route' | 'store' | 'outside' | 'bad'> = {
    zap: 'live',
    eye: 'live',
    'type-hierarchy': 'route',
    merge: 'route',
    inbox: 'route',
    'radio-tower': 'outside',
    cloud: 'outside',
    plug: 'outside',
    error: 'bad',
};

export function iconSvg(name: string): string {
    const body = PATHS[name] ?? PATHS.table;
    return (
        '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.2" ' +
        `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`
    );
}

export const iconTone = (name: string): string => TONES[name] ?? 'store';
