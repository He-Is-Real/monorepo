import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/libs/worker-identity',
  test: {
    name: 'worker-identity',
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
