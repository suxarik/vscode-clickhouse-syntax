import { defineConfig } from '@vscode/test-cli';

/**
 * Integration tests run the real extension inside a real VS Code against a real
 * ClickHouse. Everything that broke during 2.0 testing — a hung request, a
 * stale cache passing for a live one, a silent command — passed the unit suite
 * first. These exist to catch that class.
 *
 * They need a server on CLICKHOUSE_TEST_URL (default http://localhost:18123).
 */
export default defineConfig({
    files: 'out/integration/**/*.test.js',
    version: 'stable',
    workspaceFolder: './src/integration/fixture',
    mocha: {
        ui: 'bdd',
        timeout: 60_000,
        color: true,
    },
    launchArgs: ['--disable-extensions', '--disable-gpu'],
});
