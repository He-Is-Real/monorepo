const { readFileSync } = require('fs');

// Integration tests against a real SurrealDB (the version the cluster runs), started in Docker
// by the global setup. Run with `pnpm nx run database:test-integration`; kept out of `test` so
// `nx affected -t test` still works without Docker.
const swcJestConfig = JSON.parse(
  readFileSync(`${__dirname}/.spec.swcrc`, 'utf-8'),
);
swcJestConfig.swcrc = false;

module.exports = {
  displayName: 'database-integration',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': ['@swc/jest', swcJestConfig],
  },
  moduleFileExtensions: ['ts', 'js'],
  roots: ['<rootDir>/integration'],
  testMatch: ['<rootDir>/integration/**/*.int-spec.ts'],
  setupFiles: ['<rootDir>/integration/support/host-typed-arrays.ts'],
  globalSetup: '<rootDir>/integration/support/global-setup.ts',
  globalTeardown: '<rootDir>/integration/support/global-teardown.ts',
  testTimeout: 30_000,
  // The same on every machine (T4): files at once against the one SurrealDB container.
  maxWorkers: 3,
};
