import { defineConfig } from 'vitest/config';

// Integration tests against a real SurrealDB (the version the cluster runs), started in Docker
// by libs/database's global setup, with its harness (`@heisreal/database/integration-testing`).
// Run with `pnpm nx run auth:test-integration`; kept out of `test` so `nx affected -t test`
// still works without Docker.
export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/libs/auth-integration',
  test: {
    name: 'auth-integration',
    globals: true,
    environment: 'node',
    include: ['integration/**/*.int-spec.ts'],
    globalSetup: '../database/integration/support/global-setup.ts',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // The same on every machine (T4): files at once against the one SurrealDB container.
    maxWorkers: 3,
  },
});
