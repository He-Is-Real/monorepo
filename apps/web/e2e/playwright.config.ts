import { resolve } from 'node:path';
import { defineConfig } from '@playwright/test';
import { DEVICES } from './devices';
import {
  SIGNED_IN_NAME,
  STUB_DOWN_PORT,
  STUB_LIVE_PORT,
  STUB_PORT,
  WEB_CLERK_PORT,
  WEB_DOWN_PORT,
  WEB_LIVE_PORT,
  WEB_PORT,
  WEB_SIGNED_IN_PORT,
} from './servers';

// `pnpm nx e2e web`: the built standalone server (apps/web/dist, from `prune`) against a stub
// api-public-read, across the device matrix in light and dark. Screenshots land in
// test-output/e2e/screenshots (CI uploads them). More copies of the server cover Go live
// (indexing on, D48 off), api-public-read down, a signed-in visitor and the real Clerk
// (servers.ts).
const root = `${resolve(__dirname, '../../..')}/`;

export default defineConfig({
  testDir: '.',
  testMatch: '*.e2e.ts',
  outputDir: `${root}test-output/e2e/results`,
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  // The same everywhere (T4): no retry to hide a flaky test, and as many workers locally as on
  // a 4-vCPU CI runner.
  retries: 0,
  workers: 4,
  reporter: [
    ['list'],
    ['json', { outputFile: `${root}test-output/e2e/results.json` }],
  ],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    browserName: 'chromium',
    trace: 'retain-on-failure',
  },
  projects: DEVICES.map((d) => ({
    name: d.name,
    use: {
      viewport: { width: d.width, height: d.height },
      isMobile: d.mobile,
      hasTouch: d.mobile,
      deviceScaleFactor: d.scale,
    },
  })),
  webServer: [
    {
      command: `node ${root}apps/web/e2e/stub-api.mjs`,
      url: `http://127.0.0.1:${STUB_PORT}/health`,
      env: {
        STUB_PORT: String(STUB_PORT),
        STUB_LIVE_PORT: String(STUB_LIVE_PORT),
        STUB_DOWN_PORT: String(STUB_DOWN_PORT),
      },
      reuseExistingServer: false,
    },
    // A stand-in for Clerk's "Sign in" everywhere but the real-Clerk server (T4): no test
    // waits for Clerk over the network.
    web(WEB_PORT, STUB_PORT, { E2E_FIXTURES: 'true' }),
    web(WEB_LIVE_PORT, STUB_LIVE_PORT, {
      INDEXING: 'allow',
      E2E_FIXTURES: 'true',
    }),
    web(WEB_DOWN_PORT, STUB_DOWN_PORT, { E2E_FIXTURES: 'true' }),
    // Signed in: E2E_FIXTURES makes the header show this name instead of Clerk's control, so no
    // Clerk session or secret is needed.
    web(WEB_SIGNED_IN_PORT, STUB_PORT, {
      E2E_FIXTURES: 'true',
      E2E_SIGNED_IN_NAME: SIGNED_IN_NAME,
    }),
    // The real Clerk dev instance (public key), for the tests about Clerk.
    web(WEB_CLERK_PORT, STUB_PORT, {
      CLERK_PUBLISHABLE_KEY:
        'pk_test_c3VwZXJiLW1pbmstODk2Ny5jbGVyay5hY2NvdW50cy5kZXYk',
    }),
  ],
});

function web(port: number, stubPort: number, env: Record<string, string>) {
  return {
    command: `node ${root}apps/web/dist/apps/web/server.js`,
    url: `http://localhost:${port}/health`,
    env: {
      PORT: String(port),
      HOSTNAME: '127.0.0.1',
      API_PUBLIC_READ_URL: `http://127.0.0.1:${stubPort}`,
      // No INDEXING unless given: noindex, as in dev.
      SITE_URL: `http://localhost:${port}`,
      ...env,
    },
    reuseExistingServer: false,
  };
}
