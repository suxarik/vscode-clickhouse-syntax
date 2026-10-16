/**
 * @jest-environment jsdom
 *
 * Tests for preparing a drawing to leave VS Code.
 *
 * Inside the panel the SVG inherits a background, a font and a theme. A file
 * does not, so everything it relies on has to be written into it first.
 */
import { prepareSvgForExport, EXPORT_FONT_STACK, EXPORT_PADDING } from '../explain/view/exportImage';

function svgWith(inner: string): SVGSVGElement {
    const host = document.createElement('div');
    host.innerHTML = `<svg viewBox="0 0 400 200">${inner}</svg>`;
    return host.querySelector('svg') as unknown as SVGSVGElement;
}

describe('prepareSvgForExport', () => {
    it('produces XML a parser will accept, which is the whole contract', () => {
        // A duplicate xmlns is well-formed to `toContain` and fatal to a browser:
        // "XML Parsing Error: duplicate attribute".
        const markup = prepareSvgForExport(svgWith('<rect/>'), { background: '#1e1e1e', width: 400, height: 200 });
        const parsed = new DOMParser().parseFromString(markup, 'image/svg+xml');
        expect(parsed.querySelector('parsererror')).toBeNull();
    });

    it('declares the SVG namespace exactly once', () => {
        const markup = prepareSvgForExport(svgWith('<rect/>'), { background: '#1e1e1e', width: 400, height: 200 });
        expect(markup.match(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g)).toHaveLength(1);
    });

    it('declares the SVG namespace, without which the file will not open', () => {
        const markup = prepareSvgForExport(svgWith('<rect/>'), { background: '#1e1e1e', width: 400, height: 200 });
        expect(markup).toContain('xmlns="http://www.w3.org/2000/svg"');
    });

    it('paints a background, because a file has none and JPEG has no alpha', () => {
        const markup = prepareSvgForExport(svgWith('<rect/>'), { background: '#1e1e1e', width: 400, height: 200 });
        expect(markup).toContain('#1e1e1e');
    });

    it('puts the background behind the drawing, not over it', () => {
        const markup = prepareSvgForExport(svgWith('<rect id="drawn"/>'), {
            background: '#1e1e1e',
            width: 400,
            height: 200,
        });
        expect(markup.indexOf('#1e1e1e')).toBeLessThan(markup.indexOf('drawn'));
    });

    it('writes the font in, since rasterising never loads the editor font', () => {
        const markup = prepareSvgForExport(svgWith('<text>x</text>'), {
            background: '#fff',
            width: 400,
            height: 200,
        });
        expect(markup).toContain(EXPORT_FONT_STACK);
    });

    it('carries explicit pixel dimensions for the rasteriser, margin included', () => {
        const markup = prepareSvgForExport(svgWith('<rect/>'), { background: '#fff', width: 640, height: 480 });
        expect(markup).toContain(`width="${640 + EXPORT_PADDING * 2}"`);
        expect(markup).toContain(`height="${480 + EXPORT_PADDING * 2}"`);
    });

    it('leaves room around the drawing, so nothing is glued to the edge', () => {
        const markup = prepareSvgForExport(svgWith('<rect/>'), {
            background: '#1e1e1e',
            width: 400,
            height: 200,
        });

        // The canvas grows by the margin on both sides, and the viewBox shifts
        // so the drawing sits inside it rather than against the corner.
        expect(markup).toContain(`width="${400 + EXPORT_PADDING * 2}"`);
        expect(markup).toContain(`height="${200 + EXPORT_PADDING * 2}"`);
        expect(markup).toContain(`viewBox="${-EXPORT_PADDING} ${-EXPORT_PADDING} `);
    });

    it('keeps the whole drawing in view when the panel has scaled it down', () => {
        // Fit scales by changing width/height and leaving the viewBox alone, so
        // the two are in different units. Building the viewBox out of the pixel
        // size crops away whatever the scaling had shrunk.
        const source = svgWith('<rect/>');
        source.setAttribute('viewBox', '0 0 1000 800');

        const markup = prepareSvgForExport(source, { background: '#fff', width: 500, height: 400 });

        expect(markup).toContain(
            `viewBox="${-EXPORT_PADDING} ${-EXPORT_PADDING} ${1000 + EXPORT_PADDING * 2} ${800 + EXPORT_PADDING * 2}"`
        );
        // The file is still asked to render at the size it was displayed.
        expect(markup).toContain(`width="${500 + EXPORT_PADDING * 2}"`);
        expect(markup).toContain(`height="${400 + EXPORT_PADDING * 2}"`);
    });

    it('still paints the background across the margin, not just behind the drawing', () => {
        const markup = prepareSvgForExport(svgWith('<rect/>'), {
            background: '#1e1e1e',
            width: 400,
            height: 200,
        });
        const background = markup.slice(markup.indexOf('<rect'), markup.indexOf('/>', markup.indexOf('<rect')));
        expect(background).toContain('width="100%"');
        expect(background).toContain('height="100%"');
        // It must start where the viewBox starts, or the margin it was added
        // for is the one part left unpainted.
        expect(background).toContain(`x="${-EXPORT_PADDING}"`);
        expect(background).toContain(`y="${-EXPORT_PADDING}"`);
    });

    it('leaves the drawing itself untouched', () => {
        const original = svgWith('<rect id="drawn" fill="#ff0000"/>');
        prepareSvgForExport(original, { background: '#fff', width: 400, height: 200 });
        // The panel keeps showing what it showed; export works on a copy.
        expect(original.querySelectorAll('rect')).toHaveLength(1);
    });
});
