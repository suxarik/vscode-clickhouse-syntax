/**
 * Taking a drawing out of the panel.
 *
 * Inside the webview the SVG inherits a background, a font and the editor
 * theme. A saved file inherits none of that, so each one has to be written in
 * before it leaves — which is the usual reason an exported diagram opens with
 * the wrong colours, no background, and the wrong typeface.
 */

/**
 * Rasterising an SVG never loads a web font, and a font named by a CSS variable
 * does not survive the trip either, so the file names faces that exist.
 */
// Single-quoted on purpose: an XML serialiser escapes double quotes inside an
// attribute, and the escaped form is not a font stack any renderer will match.
export const EXPORT_FONT_STACK =
    "ui-monospace, 'Cascadia Mono', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";

export interface ExportOptions {
    background: string;
    width: number;
    height: number;
}

/** A standalone copy of the drawing, as SVG source. */
export function prepareSvgForExport(source: SVGSVGElement, options: ExportOptions): string {
    const copy = source.cloneNode(true) as SVGSVGElement;

    copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    copy.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
    copy.setAttribute('width', String(options.width));
    copy.setAttribute('height', String(options.height));
    copy.setAttribute('font-family', EXPORT_FONT_STACK);

    const style = copy.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = `text { font-family: ${EXPORT_FONT_STACK}; }`;
    copy.insertBefore(style, copy.firstChild);

    const background = copy.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'rect');
    background.setAttribute('x', '0');
    background.setAttribute('y', '0');
    background.setAttribute('width', '100%');
    background.setAttribute('height', '100%');
    background.setAttribute('fill', options.background);
    copy.insertBefore(background, copy.firstChild);

    return new XMLSerializer().serializeToString(copy);
}

export type ImageFormat = 'svg' | 'png' | 'jpg';

const MIME: Record<ImageFormat, string> = {
    svg: 'image/svg+xml',
    png: 'image/png',
    jpg: 'image/jpeg',
};

/**
 * Rasterise the prepared SVG, at twice the device scale so the labels stay
 * sharp wherever the file ends up.
 */
export async function rasterize(
    markup: string,
    format: Exclude<ImageFormat, 'svg'>,
    options: ExportOptions,
    scale = 2
): Promise<string> {
    const source = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('The drawing could not be rendered as an image.'));
        image.src = source;
    });

    const canvas = document.createElement('canvas');
    canvas.width = options.width * scale;
    canvas.height = options.height * scale;

    const context = canvas.getContext('2d');
    if (!context) throw new Error('This editor cannot rasterise images.');
    // JPEG has no transparency, so the background is painted rather than assumed.
    context.fillStyle = options.background;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    return canvas.toDataURL(MIME[format], 0.95);
}
