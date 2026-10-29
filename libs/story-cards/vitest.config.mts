import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/libs/story-cards',
  test: {
    name: 'story-cards',
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
