/**
 * Tests for constants.
 */
import { CH_DETECTION_PATTERNS, CH_KEYWORDS, CH_DATA_TYPES } from '../constants';

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

    it('has data types', () => {
        expect(CH_DATA_TYPES.length).toBeGreaterThan(0);
        expect(CH_DATA_TYPES).toContain('UInt64');
        expect(CH_DATA_TYPES).toContain('String');
        expect(CH_DATA_TYPES).toContain('DateTime');
    });
});
