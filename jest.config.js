module.exports = {
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/tests/setup/env.js'],
  testMatch: ['**/tests/**/*.test.js'],
  collectCoverage: true,
  collectCoverageFrom: ['index.js'],
  coverageReporters: ['text', 'text-summary', 'lcov', 'html'],
  coverageThreshold: {
    global: {
      statements: 90,
      branches: 85,
      functions: 90,
      lines: 90,
    },
  },
  verbose: true,
  clearMocks: true,
};