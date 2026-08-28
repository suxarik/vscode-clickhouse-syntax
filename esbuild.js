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
    external: ['vscode'],
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
            external: [],
            outfile: 'dist/results.js',
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
