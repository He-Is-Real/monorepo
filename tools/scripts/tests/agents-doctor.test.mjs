// tools/scripts/agents-doctor.mjs (`pnpm agents:doctor`): the repo half passes on this repo, and the
// machine half never fails.
//
//   node --test tools/scripts/tests/
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../agents-doctor.mjs', import.meta.url));
const run = (args) =>
  spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

test('--repo: skills, the .claude/skills link and folder CLAUDE.md files are in order', () => {
  const r = run(['--repo']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /repo OK/);
});

test('the machine half reports and exits 0', () => {
  const r = run([]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Required plugins missing/);
});
