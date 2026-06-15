/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: [
    '**/tests/**/*.test.js',
    '**/tests/**/test_*.js',
  ],
  // Ignore git worktrees and the unrelated srq-pptx folder (stale duplicate test suites).
  testPathIgnorePatterns: ['/node_modules/', '/\\.worktrees/', '/srq-pptx/'],
  modulePathIgnorePatterns: ['/\\.worktrees/', '/srq-pptx/'],
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/server.js',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov'],
  // Background DB pool/schedulers aren't torn down in tests; without this, npm test hangs.
  forceExit: true,
  verbose: true,
};
