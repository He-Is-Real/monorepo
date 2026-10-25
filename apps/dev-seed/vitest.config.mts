import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/dev-seed',
  test: {
    name: 'dev-seed',
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
