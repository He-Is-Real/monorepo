import { resolve } from 'node:path';
import { defineConfig } from '@playwright/test';
import { DEVICES } from './devices';

// `pnpm nx e2e web`: the built standalone server (apps/web/dist, from `prune`) against a stub
// api-public-read, across the device matrix in light and dark. Screenshots land in
// test-output/e2e/screenshots (CI uploads them).
// Fixed defaults; E2E_*_PORT override them when another run is using one (CI never sets them).
const port = (name: string, fallback: number) =>
  Number(process.env[name] ?? fallback);
const WEB_PORT = port('E2E_WEB_PORT', 4300);
export const STUB_PORT = port('E2E_STUB_PORT', 4310);
/** The signed-in fixture server (header.e2e.ts). */
export const SIGNED_IN_PORT = port('E2E_SIGNED_IN_PORT', 4301);
/** 40 characters: long names must truncate before anything in the header wraps. */
export const SIGNED_IN_NAME = 'Bartholomew Montgomery-Fitzwilliam Smith';
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
        // No INDEXING: noindex, as in dev.
        SITE_URL: `http://localhost:${WEB_PORT}`,
        // The Clerk dev instance (public): the real sign-in button loads in the browser.
        CLERK_PUBLISHABLE_KEY:
          'pk_test_c3VwZXJiLW1pbmstODk2Ny5jbGVyay5hY2NvdW50cy5kZXYk',
      },
      reuseExistingServer: false,
    },
    {
      // The same build, signed in (header.e2e.ts): E2E_FIXTURES makes the header show this
      // name instead of Clerk's control, so no Clerk session or secret is needed.
      command: `node ${root}apps/web/dist/apps/web/server.js`,
      url: `http://localhost:${SIGNED_IN_PORT}/health`,
      env: {
        PORT: String(SIGNED_IN_PORT),
        HOSTNAME: '127.0.0.1',
        API_PUBLIC_READ_URL: `http://127.0.0.1:${STUB_PORT}`,
        SITE_URL: `http://localhost:${SIGNED_IN_PORT}`,
        E2E_FIXTURES: 'true',
        E2E_SIGNED_IN_NAME: SIGNED_IN_NAME,
      },
      reuseExistingServer: false,
    },
  ],
});
