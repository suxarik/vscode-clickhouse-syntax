/* eslint-disable no-console */
const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** Reports build failures with file/line so CI logs are useful. */
const problemMatcher = {
    name: 'problem-matcher',
    setup(build) {
        build.onEnd(result => {
            for (const error of result.errors) {
                const where = error.location ? ` ${error.location.file}:${error.location.line}:${error.location.column}` : '';
                console.error(`✘ [ERROR] ${error.text}${where}`);
            }
            if (result.errors.length === 0) {
                console.log(`build finished${production ? ' (production)' : ''}`);
            }
        });
    },
};

/** Shared between the desktop and web builds. */
const common = {
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    // Provided by the VS Code extension host, never bundled.
    // node:* stays external: the desktop build requires it, and the web build
    // catches the failing require and falls back to fetch.
    external: ['vscode', 'node:http', 'node:https'],
    logLevel: 'silent',
    plugins: [problemMatcher],
};

async function main() {
    const contexts = await Promise.all([
        esbuild.context({ ...common, platform: 'node', target: 'node18', outfile: 'dist/extension.js' }),
        // The result grid runs inside a webview, and later a notebook renderer.
        esbuild.context({
            ...common,
            entryPoints: ['src/results/view/webviewEntry.ts'],
            format: 'iife',
            platform: 'browser',
            target: 'es2022',
            external: ['node:http', 'node:https'],
            outfile: 'dist/results.js',
        }),
        // The notebook output renderer: its own iframe, its own ESM bundle, and
        // no `vscode` API at all. It imports the same GridView the webview does.
        esbuild.context({
            ...common,
            entryPoints: ['src/notebook/renderer.ts'],
            format: 'esm',
            platform: 'browser',
            target: 'es2022',
            external: ['node:http', 'node:https'],
            outfile: 'dist/renderer.js',
        }),
        // The web build runs in a browser worker: no Node built-ins available.
        esbuild.context({
            ...common,
            platform: 'browser',
            target: 'es2022',
            outfile: 'dist/web/extension.js',
        }),
    ]);

    if (watch) {
        await Promise.all(contexts.map(context => context.watch()));
    } else {
        await Promise.all(contexts.map(context => context.rebuild()));
        await Promise.all(contexts.map(context => context.dispose()));
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
