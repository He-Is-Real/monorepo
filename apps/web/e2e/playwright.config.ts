import { resolve } from 'node:path';
import { defineConfig } from '@playwright/test';
import { DEVICES } from './devices';

// `pnpm nx e2e web`: the built standalone server (apps/web/dist, from `prune`) against a stub
// api-public-read, across the device matrix in light and dark. Screenshots land in
// test-output/e2e/screenshots (CI uploads them).
const WEB_PORT = 4300;
const STUB_PORT = 4310;
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
      env: { STUB_PORT: String(STUB_PORT) },
      reuseExistingServer: false,
    },
    {
      command: `node ${root}apps/web/dist/apps/web/server.js`,
      url: `http://localhost:${WEB_PORT}/health`,
      env: {
        PORT: String(WEB_PORT),
        HOSTNAME: '127.0.0.1',
        API_PUBLIC_READ_URL: `http://127.0.0.1:${STUB_PORT}`,
        FEATURED_STORY_SLUG: 'test-story-walking-skeleton',
        ROBOTS_NOINDEX: 'true',
        // The Clerk dev instance (public): the real sign-in button loads in the browser.
        CLERK_PUBLISHABLE_KEY:
          'pk_test_c3VwZXJiLW1pbmstODk2Ny5jbGVyay5hY2NvdW50cy5kZXYk',
      },
      reuseExistingServer: false,
    },
  ],
});
