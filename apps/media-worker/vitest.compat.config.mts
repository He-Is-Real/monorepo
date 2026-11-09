import { defineConfig } from 'vitest/config';

// Compatibility checks against other programs' client libraries (compat/*.compat-spec.ts), e.g.
// Dapr's Go client across certificate renewals. LOCAL ONLY, never in CI: they need Go and openssl
// and download Go modules. `pnpm nx run media-worker:compat-test`.
export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/media-worker-compat',
  test: {
    name: 'media-worker-compat',
    globals: true,
    environment: 'node',
    include: ['compat/**/*.compat-spec.ts'],
    // The first run builds the Go stand-in, downloading its modules.
    hookTimeout: 300_000,
    testTimeout: 60_000,
  },
});
