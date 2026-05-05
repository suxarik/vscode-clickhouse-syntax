/**
 * Tests for function database completeness.
 */
import { CH_FUNCTION_DOCS } from '../functionDocs';

describe('CH_FUNCTION_DOCS', () => {
    it('has over 200 functions', () => {
        expect(Object.keys(CH_FUNCTION_DOCS).length).toBeGreaterThan(200);
    });

    it('has required fields for every function', () => {
        for (const [key, doc] of Object.entries(CH_FUNCTION_DOCS)) {
            expect(doc.name).toBeTruthy();
            expect(doc.description).toBeTruthy();
            expect(doc.category).toBeTruthy();
            if (!doc.signature) {
                console.warn(`Function ${key} missing signature`);
            }
        }
    });

    it('covers all expected categories', () => {
        const categories = new Set<string>();
        for (const doc of Object.values(CH_FUNCTION_DOCS)) {
            if (doc.category) categories.add(doc.category);
        }
        const expected = ['aggregate', 'array', 'string', 'date', 'conversion', 'conditional', 'math', 'uuid', 'dict', 'hash', 'ip', 'json', 'map', 'tuple', 'other'];
        for (const cat of expected) {
            expect(categories.has(cat)).toBe(true);
        }
    });

    it('has no duplicate keys', () => {
        const keys = Object.keys(CH_FUNCTION_DOCS);
        const uniqueKeys = new Set(keys);
        expect(keys.length).toBe(uniqueKeys.size);
    });
});
