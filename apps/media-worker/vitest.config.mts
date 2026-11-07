import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/media-worker',
  test: {
    name: 'media-worker',
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
