// tools/scripts/logs.mjs (`pnpm logs`): one short line per JSON log line, ours or Google's.
//
//   node --test tools/scripts/tests/
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../logs.mjs', import.meta.url));
const run = (input, args = []) =>
  spawnSync(process.execPath, [script, ...args], {
    input,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  }).stdout;

const event = {
  severity: 'WARNING',
  message: 'GET /v1/stories 429 in 3 ms',
  timestamp: '2026-11-24T12:00:00.123Z',
  event: 'request',
  ref: '019ab7c4-0000-7000-8000-000000000001',
  service: { name: 'api-public-read' },
  outcome: 'rate_limited',
  http: { status_code: 429, duration_ms: 3 },
};

test('shows time, severity, service, message, outcome and reference on one line', () => {
  assert.equal(
    run(`${JSON.stringify(event)}\nplain text\n`),
    '12:00:00.123 WARNING  api-public-read request GET /v1/stories 429 in 3 ms outcome=rate_limited status=429 3ms ref=019ab7c4-0000-7000-8000-000000000001\nplain text\n',
  );
});

test("reads gcloud's JSON array of entries", () => {
  const { severity, timestamp, ...jsonPayload } = event;
  const out = run(
    JSON.stringify([{ severity, timestamp, jsonPayload }], null, 2),
  );
  assert.match(out, /^12:00:00\.123 WARNING {2}api-public-read request GET/);
});

test('prints an entry it can’t sum up as it came, and carries on', () => {
  const broken = '{"message":{"toString":null}}';
  const out = run(`${broken}\n${JSON.stringify(event)}\n`);
  const lines = out.split('\n');
  assert.equal(lines[0], broken);
  assert.match(
    lines[1],
    /^12:00:00\.123 WARNING {2}api-public-read request GET/,
  );
});
