import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/libs/secrets',
  test: {
    name: 'secrets',
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
