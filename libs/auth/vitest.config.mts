import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/libs/auth',
  test: {
    name: 'auth',
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
