/**
 * @jest-environment jsdom
 *
 * Tests for preparing a drawing to leave VS Code.
 *
 * Inside the panel the SVG inherits a background, a font and a theme. A file
 * does not, so everything it relies on has to be written into it first.
 */
import { prepareSvgForExport, EXPORT_FONT_STACK } from '../explain/view/exportImage';

function svgWith(inner: string): SVGSVGElement {
    const host = document.createElement('div');
    host.innerHTML = `<svg viewBox="0 0 400 200">${inner}</svg>`;
    return host.querySelector('svg') as unknown as SVGSVGElement;
}

describe('prepareSvgForExport', () => {
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

    it('carries explicit pixel dimensions for the rasteriser', () => {
        const markup = prepareSvgForExport(svgWith('<rect/>'), { background: '#fff', width: 640, height: 480 });
        expect(markup).toContain('width="640"');
        expect(markup).toContain('height="480"');
    });

    it('leaves the drawing itself untouched', () => {
        const original = svgWith('<rect id="drawn" fill="#ff0000"/>');
        prepareSvgForExport(original, { background: '#fff', width: 400, height: 200 });
        // The panel keeps showing what it showed; export works on a copy.
        expect(original.querySelectorAll('rect')).toHaveLength(1);
    });
});
