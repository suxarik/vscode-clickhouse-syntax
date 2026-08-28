/**
 * Tests for constants.
 */
import { CH_DETECTION_PATTERNS, CH_KEYWORDS } from '../constants';

describe('constants', () => {
    it('has detection patterns', () => {
        expect(CH_DETECTION_PATTERNS.length).toBeGreaterThan(0);
        expect(CH_DETECTION_PATTERNS.every(p => p instanceof RegExp)).toBe(true);
    });

    it('has keywords', () => {
        expect(CH_KEYWORDS.length).toBeGreaterThan(0);
        expect(CH_KEYWORDS).toContain('SELECT');
        expect(CH_KEYWORDS).toContain('FROM');
        expect(CH_KEYWORDS).toContain('WHERE');
    });
});
