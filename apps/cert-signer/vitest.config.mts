import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/cert-signer',
  test: {
    name: 'cert-signer',
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
