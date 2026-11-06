import { defineConfig } from 'vitest/config';

// The local scale test (database review 2, B2): 50,000 stories in a throwaway SurrealDB, the
// version the cluster runs, started in Docker by libs/database's global setup. LOCAL ONLY, never
// in CI: `pnpm nx run api-public-read:scale-test` (SCALE_STORIES=5000 for a quicker run).
export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/api-public-read-scale',
  test: {
    name: 'api-public-read-scale',
    globals: true,
    environment: 'node',
    include: ['scale/**/*.scale-spec.ts'],
    globalSetup: '../../libs/database/integration/support/global-setup.ts',
    testTimeout: 3_600_000,
    // Loading 50,000 stories takes a while.
    hookTimeout: 4 * 3_600_000,
    maxWorkers: 1,
  },
});
