import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/libs/logging',
  test: {
    name: 'logging',
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
