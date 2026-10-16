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

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/**
 * Margin around an exported drawing.
 *
 * In the panel the canvas scrolls and the drawing can sit against the edge. A
 * file has no scroll and no surroundings, so the first and last rows need room
 * or they read as cropped.
 */
export const EXPORT_PADDING = 16;

export interface ExportOptions {
    background: string;
    width: number;
    height: number;
}

interface ViewBox {
    x: number;
    y: number;
    width: number;
    height: number;
}

function viewBoxOf(svg: SVGSVGElement): ViewBox | undefined {
    const parts = (svg.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
    if (parts.length !== 4 || parts.some(part => !Number.isFinite(part))) return undefined;
    return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
}

/** A standalone copy of the drawing, as SVG source. */
export function prepareSvgForExport(source: SVGSVGElement, options: ExportOptions): string {
    const copy = source.cloneNode(true) as SVGSVGElement;

    // An element already in the SVG namespace gets its xmlns from the
    // serialiser. Adding one as a plain attribute emits it twice, and a second
    // xmlns is not untidy XML, it is invalid XML: browsers refuse the file with
    // "duplicate attribute". Only a non-namespaced element needs the help.
    if (copy.namespaceURI !== SVG_NAMESPACE) copy.setAttribute('xmlns', SVG_NAMESPACE);

    // Two coordinate systems meet here. `width` and `height` are the pixel size
    // the panel displayed, which Fit may have scaled down; the viewBox is in the
    // units the drawing was composed in. Padding has to be applied to each in
    // its own units — taking the viewBox from the pixel size crops away exactly
    // what the scaling shrank.
    const box = viewBoxOf(copy) ?? { x: 0, y: 0, width: options.width, height: options.height };
    copy.setAttribute(
        'viewBox',
        `${box.x - EXPORT_PADDING} ${box.y - EXPORT_PADDING} ` +
            `${box.width + EXPORT_PADDING * 2} ${box.height + EXPORT_PADDING * 2}`
    );
    copy.setAttribute('width', String(options.width + EXPORT_PADDING * 2));
    copy.setAttribute('height', String(options.height + EXPORT_PADDING * 2));
    copy.setAttribute('font-family', EXPORT_FONT_STACK);

    const style = copy.ownerDocument.createElementNS(SVG_NAMESPACE, 'style');
    style.textContent = `text { font-family: ${EXPORT_FONT_STACK}; }`;
    copy.insertBefore(style, copy.firstChild);

    const background = copy.ownerDocument.createElementNS(SVG_NAMESPACE, 'rect');
    // The background is placed in the same units, at the padded origin, so the
    // margin it was added for is painted rather than left transparent.
    background.setAttribute('x', String((viewBoxOf(copy)?.x ?? 0)));
    background.setAttribute('y', String((viewBoxOf(copy)?.y ?? 0)));
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
    canvas.width = (options.width + EXPORT_PADDING * 2) * scale;
    canvas.height = (options.height + EXPORT_PADDING * 2) * scale;

    const context = canvas.getContext('2d');
    if (!context) throw new Error('This editor cannot rasterise images.');
    // JPEG has no transparency, so the background is painted rather than assumed.
    context.fillStyle = options.background;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    return canvas.toDataURL(MIME[format], 0.95);
}
