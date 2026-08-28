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

async function main() {
    const context = await esbuild.context({
        entryPoints: ['src/extension.ts'],
        bundle: true,
        format: 'cjs',
        minify: production,
        sourcemap: !production,
        sourcesContent: false,
        platform: 'node',
        target: 'node16',
        outfile: 'dist/extension.js',
        // Provided by the VS Code extension host, never bundled.
        external: ['vscode'],
        logLevel: 'silent',
        plugins: [problemMatcher],
    });

    if (watch) {
        await context.watch();
    } else {
        await context.rebuild();
        await context.dispose();
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
