const { readFileSync } = require('fs');

// Integration tests against a real SurrealDB (the version the cluster runs), started in Docker
// by libs/database's global setup, with its harness (`@heisreal/database/integration-testing`).
// Run with `pnpm nx run consent:test-integration`; kept out of `test` so `nx affected -t test`
// still works without Docker.
const swcJestConfig = JSON.parse(
  readFileSync(`${__dirname}/.spec.swcrc`, 'utf-8'),
);
swcJestConfig.swcrc = false;

const support = '<rootDir>/../database/integration/support';

module.exports = {
  displayName: 'consent-integration',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': ['@swc/jest', swcJestConfig],
  },
  moduleFileExtensions: ['ts', 'js'],
  roots: ['<rootDir>/integration'],
  testMatch: ['<rootDir>/integration/**/*.int-spec.ts'],
  setupFiles: [`${support}/host-typed-arrays.ts`],
  globalSetup: `${support}/global-setup.ts`,
  globalTeardown: `${support}/global-teardown.ts`,
  testTimeout: 30_000,
};
