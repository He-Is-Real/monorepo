import { resolve } from 'node:path';
import { defineConfig } from '@playwright/test';

// D50 "Dev behavioural tests": the deployed dev site and api-public-read, right after a reset to
// the D47 dataset (.github/workflows/dev-behavioural-tests.yml). Run locally against dev with
// `pnpm nx run dev-seed:behavioural` (reset first: the tests expect exactly the dataset).
// DEV_WEB_URL and DEV_API_URL override the dev URLs.
const root = `${resolve(__dirname, '../../..')}/`;

export const WEB_URL =
  process.env['DEV_WEB_URL'] ?? 'https://web-jbxp6odnsa-nw.a.run.app';
export const API_URL =
  process.env['DEV_API_URL'] ??
  'https://api-public-read-jbxp6odnsa-nw.a.run.app';

export default defineConfig({
  testDir: '.',
  testMatch: '*.behaviour.ts',
  outputDir: `${root}test-output/behavioural/results`,
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  // Cloud Run scales to zero: warm-up.ts wakes both services first, so no test retries (T4).
  globalSetup: './warm-up.ts',
  retries: 0,
  timeout: 60_000,
  workers: 4,
  reporter: [['list']],
  use: {
    baseURL: WEB_URL,
    browserName: 'chromium',
    trace: 'retain-on-failure',
  },
});
