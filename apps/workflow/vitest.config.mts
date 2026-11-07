import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/workflow',
  test: {
    name: 'workflow',
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    // Its behaviour is the database's: integration/ (pnpm nx run workflow:test-integration).
    passWithNoTests: true,
  },
});
