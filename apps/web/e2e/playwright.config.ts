import { resolve } from 'node:path';
import { defineConfig } from '@playwright/test';
import { DEVICES } from './devices';
import {
  SIGNED_IN_NAME,
  STUB_DOWN_PORT,
  STUB_LIVE_PORT,
  STUB_PORT,
  WEB_DOWN_PORT,
  WEB_LIVE_PORT,
  WEB_PORT,
  WEB_SIGNED_IN_PORT,
} from './servers';

// `pnpm nx e2e web`: the built standalone server (apps/web/dist, from `prune`) against a stub
// api-public-read, across the device matrix in light and dark. Screenshots land in
// test-output/e2e/screenshots (CI uploads them). More copies of the server cover Go live
// (indexing on, D48 off), api-public-read down and a signed-in visitor (servers.ts).
const root = `${resolve(__dirname, '../../..')}/`;

export default defineConfig({
  testDir: '.',
  testMatch: '*.e2e.ts',
  outputDir: `${root}test-output/e2e/results`,
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 1 : 0,
  workers: process.env['CI'] ? 4 : undefined,
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
    web(WEB_PORT, STUB_PORT, {}),
    web(WEB_LIVE_PORT, STUB_LIVE_PORT, { INDEXING: 'allow' }),
    web(WEB_DOWN_PORT, STUB_DOWN_PORT, {}),
    // Signed in: E2E_FIXTURES makes the header show this name instead of Clerk's control, so no
    // Clerk session or secret is needed.
    web(WEB_SIGNED_IN_PORT, STUB_PORT, {
      E2E_FIXTURES: 'true',
      E2E_SIGNED_IN_NAME: SIGNED_IN_NAME,
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
      // The Clerk dev instance (public): the real sign-in button loads in the browser.
      ...(env['E2E_FIXTURES']
        ? {}
        : {
            CLERK_PUBLISHABLE_KEY:
              'pk_test_c3VwZXJiLW1pbmstODk2Ny5jbGVyay5hY2NvdW50cy5kZXYk',
          }),
      ...env,
    },
    reuseExistingServer: false,
  };
}
