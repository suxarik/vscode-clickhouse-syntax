/**
 * Tests for the guided connection setup.
 */
import { parseTarget, suggestName } from '../client/connectionSetup';

describe('parseTarget', () => {
    it('accepts a bare host', () => {
        expect(parseTarget('localhost')).toEqual({ protocol: 'http', host: 'localhost', port: 8123 });
    });

    it('accepts host:port', () => {
        expect(parseTarget('ch.internal:9000')).toEqual({
            protocol: 'http',
            host: 'ch.internal',
            port: 9000,
        });
    });

    it('accepts a full URL', () => {
        expect(parseTarget('https://abc.clickhouse.cloud:8443')).toEqual({
            protocol: 'https',
            host: 'abc.clickhouse.cloud',
            port: 8443,
        });
    });

    it('defaults the port from the scheme', () => {
        // ClickHouse Cloud hands out URLs with no port.
        expect(parseTarget('https://abc.clickhouse.cloud')?.port).toBe(8443);
        expect(parseTarget('http://ch.internal')?.port).toBe(8123);
    });

    it('ignores a path someone pasted along with the host', () => {
        expect(parseTarget('https://ch.internal:8443/play')?.host).toBe('ch.internal');
    });

    it('rejects nonsense', () => {
        expect(parseTarget('')).toBeUndefined();
        expect(parseTarget('   ')).toBeUndefined();
        expect(parseTarget('http://')).toBeUndefined();
    });
});

describe('suggestName', () => {
    it('calls localhost "local"', () => {
        expect(suggestName('localhost', [])).toBe('local');
        expect(suggestName('127.0.0.1', [])).toBe('local');
    });

    it('uses the first label of a hostname', () => {
        expect(suggestName('warehouse.eu.internal', [])).toBe('warehouse');
    });

    it('avoids a name already taken', () => {
        expect(suggestName('localhost', ['local'])).toBe('local-2');
        expect(suggestName('localhost', ['local', 'local-2'])).toBe('local-3');
    });
});
