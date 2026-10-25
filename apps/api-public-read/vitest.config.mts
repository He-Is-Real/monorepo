import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/api-public-read',
  test: {
    name: 'api-public-read',
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
