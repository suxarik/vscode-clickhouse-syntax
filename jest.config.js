/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    roots: ['<rootDir>/src'],
    testMatch: ['**/__tests__/**/*.test.ts'],
    collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts', '!src/**/__tests__/**'],
    coverageDirectory: 'coverage',
    coverageReporters: ['text', 'lcov'],
    // Ratchet these up with each release; see plans/ for the schedule.
    coverageThreshold: {
        global: { statements: 70, branches: 70, functions: 65, lines: 70 },
    },
    setupFiles: ['<rootDir>/src/__tests__/setup.ts'],
    moduleNameMapper: {
        '^vscode$': '<rootDir>/src/__tests__/mocks/vscode.ts',
    },
};
