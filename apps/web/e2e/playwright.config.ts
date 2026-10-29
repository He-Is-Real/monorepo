import { resolve } from 'node:path';
import { defineConfig } from '@playwright/test';
import { DEVICES } from './devices';
import {
  SIGNED_IN_NAME,
  STUB_DOWN_PORT,
  STUB_LIVE_PORT,
  STUB_PORT,
  STUB_USER_PORT,
  STUB_USER_URL,
  WEB_DOWN_PORT,
  WEB_LIVE_PORT,
  WEB_PORT,
  WEB_SIGNED_IN_PORT,
} from './servers';

// `pnpm nx e2e web`: the built standalone server (apps/web/dist, from `prune`) against a stub
// api-public-read (and, for the signed-in server's browser, a stub api-user), across the device
// matrix in light and dark. Screenshots land in
// test-output/e2e/screenshots (CI uploads them). More copies of the server cover Go live
// (indexing on, D48 off), api-public-read down and a signed-in visitor (servers.ts). Nothing
// is loaded over the internet: the real Clerk is checked on dev (apps/dev-seed/behavioural).
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
  // Waits are for a condition, never a fixed time; these are only the ceilings. Some of what
  // the tests wait for appears only once the page's JavaScript has run (the error page, the
  // account panel): 6 to 9 s under a 20x CPU throttle, past Playwright's 5 s default (Codex
  // review of #72, round 3). A passing test takes no longer for them.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [
    ['list'],
    ['json', { outputFile: `${root}test-output/e2e/results.json` }],
    // CI runs the suite in shards (ci.yml); their blob reports merge into one HTML report.
    ...(process.env['CI']
      ? ([['blob', { outputDir: `${root}test-output/e2e/blob` }]] as const)
      : []),
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
    {
      command: `node ${root}apps/web/e2e/stub-api-user.mjs`,
      url: `${STUB_USER_URL}/health`,
      env: {
        STUB_USER_PORT: String(STUB_USER_PORT),
        // Hearts' cards come from the stub api-public-read, as api-user reads publicStory.
        STUB_PUBLIC_URL: `http://127.0.0.1:${STUB_PORT}`,
        // CORS: only the signed-in server's origin, as OpenTofu allows only web's (D31).
        STUB_USER_ORIGINS: `http://localhost:${WEB_SIGNED_IN_PORT}`,
      },
      reuseExistingServer: false,
    },
    // A stand-in for Clerk's "Sign in" on every server (T4): no test waits for Clerk over the
    // network.
    web(WEB_PORT, STUB_PORT, { E2E_FIXTURES: 'true' }),
    web(WEB_LIVE_PORT, STUB_LIVE_PORT, {
      INDEXING: 'allow',
      E2E_FIXTURES: 'true',
    }),
    web(WEB_DOWN_PORT, STUB_DOWN_PORT, { E2E_FIXTURES: 'true' }),
    // Signed in: E2E_FIXTURES makes the header show this name instead of Clerk's control, so no
    // Clerk session or secret is needed. Its browser calls the stub api-user.
    web(WEB_SIGNED_IN_PORT, STUB_PORT, {
      E2E_FIXTURES: 'true',
      E2E_SIGNED_IN_NAME: SIGNED_IN_NAME,
      API_USER_URL: STUB_USER_URL,
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
