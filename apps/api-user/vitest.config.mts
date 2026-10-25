import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/api-user',
  test: {
    name: 'api-user',
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
