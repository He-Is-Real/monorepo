import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { STUB_PORT, WEB_NO_KEYS_PORT } from './servers';

// The website refuses to start when deployed without its log keys (writing-logs skill; like
// the APIs). Cloud Run sets K_SERVICE; here neither LOG_HMAC_SECRET nor LOG_SEARCH_HMAC_SECRET
// is set and E2E_FIXTURES is off, so the built server must exit instead of serving pages that
// all fail (Codex review of #286). Not about the screen: one device.

// eslint-disable-next-line no-empty-pattern
test.beforeEach(({}, info) => {
  test.skip(
    info.project.name !== 'desktop-1280',
    'one device: no page involved',
  );
});

test('a deployed website without its log keys exits instead of serving', async () => {
  const server = resolve(__dirname, '../dist/apps/web/server.js');
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('LOG_') && k !== 'E2E_FIXTURES')
      env[k] = v;
  }
  const child = spawn(process.execPath, [server], {
    env: {
      ...env,
      PORT: String(WEB_NO_KEYS_PORT),
      HOSTNAME: '127.0.0.1',
      API_PUBLIC_READ_URL: `http://127.0.0.1:${STUB_PORT}`,
      SITE_URL: `http://localhost:${WEB_NO_KEYS_PORT}`,
      SITE_ENVIRONMENT: 'dev',
      K_SERVICE: 'web',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d: Buffer) => (output += d.toString()));
  child.stderr.on('data', (d: Buffer) => (output += d.toString()));
  try {
    const code = await new Promise<number | null>((done) =>
      child.on('close', (c) => done(c)),
    );
    expect(code).toBe(1);
    const line = output
      .split('\n')
      .filter((l) => l.startsWith('{'))
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((e) => e['event'] === 'startup' && e['severity'] === 'CRITICAL');
    expect(line?.['message']).toBe(
      'The website could not load its log keys and will not start',
    );
  } finally {
    child.kill();
  }
});
