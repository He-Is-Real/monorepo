import { resolve } from 'node:path';
import { defineConfig } from '@playwright/test';
import { WEB_URL } from './playwright.config';

// Tests a developer runs against dev with their own gcloud ADC, because they read keys only
// developers (and the services) may read: `pnpm nx run dev-seed:upload-spike`. Not part of CI's
// "Dev behavioural tests" (playwright.config.ts), whose test job has no Google identity.
const root = `${resolve(__dirname, '../../..')}/`;

export default defineConfig({
  testDir: '.',
  testMatch: '*.developer.ts',
  outputDir: `${root}test-output/behavioural-developer/results`,
  forbidOnly: !!process.env['CI'],
  retries: 0,
  timeout: 60_000,
  workers: 2,
  reporter: [['list']],
  use: {
    baseURL: WEB_URL,
    browserName: 'chromium',
    trace: 'off', // a trace would record the signed links
  },
});
