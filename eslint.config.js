const tseslint = require('typescript-eslint');

module.exports = tseslint.config(
    {
        ignores: ['out/**', 'dist/**', 'node_modules/**', 'coverage/**', 'esbuild.js'],
    },
    ...tseslint.configs.recommended,
    {
        files: ['src/**/*.ts'],
        languageOptions: {
            parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
        },
        rules: {
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
            '@typescript-eslint/no-explicit-any': 'warn',
            eqeqeq: ['error', 'always', { null: 'ignore' }],
            'no-console': 'off',
            curly: ['error', 'multi-line'],
        },
    },
    {
        files: ['src/__tests__/**/*.ts'],
        rules: {
            '@typescript-eslint/no-explicit-any': 'off',
        },
    }
);
