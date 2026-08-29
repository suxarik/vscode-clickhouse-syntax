/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    roots: ['<rootDir>/src'],
    testMatch: ['**/__tests__/**/*.test.ts'],
    // `src/integration` runs under @vscode/test-electron, not jest, so counting
    // it here would report it as untested when it is the opposite.
    collectCoverageFrom: [
        'src/**/*.ts',
        '!src/**/*.d.ts',
        '!src/**/__tests__/**',
        '!src/integration/**',
        '!src/catalog/generated/**',
    ],
    coverageDirectory: 'coverage',
    coverageReporters: ['text', 'lcov'],
    // Ratchet these up with each release; see plans/ for the schedule.
    // Set just under what the suite currently reaches, so a real regression
    // fails the build without a one-statement change doing so.
    coverageThreshold: {
        global: { statements: 80, branches: 75, functions: 78, lines: 82 },
    },
    setupFiles: ['<rootDir>/src/__tests__/setup.ts'],
    moduleNameMapper: {
        '^vscode$': '<rootDir>/src/__tests__/mocks/vscode.ts',
    },
};
