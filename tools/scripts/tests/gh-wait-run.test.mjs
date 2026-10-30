// tools/scripts/gh-wait-run.sh: tofu-apply.yml waits for the target's Release Images before it
// plans and for the target's CI before it applies (pipeline speed review, P1: a merge whose CI
// failed on main must never deploy). Run against a stub `gh` that answers each call from a
// script of API states, so "still running, then finished" plays out without any real waiting.
//
//   node --test tools/scripts/tests/
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../gh-wait-run.sh', import.meta.url));
const SHA = 'a'.repeat(40);

// Each call answers with the next entry of `answers` (the last one repeats): a list of runs as
// the API returns them, or 'error' for a failed call. The query is logged for the assertions.
const STUB_GH = `#!/usr/bin/env node
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { answers, log, counter } = JSON.parse(fs.readFileSync(process.env.STUB_GH_STATE, 'utf8'));
const n = Number(fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8') : 0);
fs.writeFileSync(counter, String(n + 1));
const [, path, flag, expr] = process.argv.slice(2);
fs.appendFileSync(log, path + '\\n');
const answer = answers[Math.min(n, answers.length - 1)];
if (answer === 'error' || flag !== '--jq') process.exit(1);
process.stdout.write(execFileSync('jq', ['-r', expr], { input: JSON.stringify({ workflow_runs: answer }) }));
`;

const run = (id, status, conclusion = null) => ({ id, status, conclusion });

/** Runs the script against `answers`; returns its exit code, stdout and the queries it made. */
function wait(
  answers,
  { timeout = '30', workflow = 'ci.yml', sha = SHA } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'gh-wait-run-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), STUB_GH);
    chmodSync(join(bin, 'gh'), 0o755);
    const log = join(dir, 'log');
    writeFileSync(log, '');
    const state = join(dir, 'state.json');
    writeFileSync(
      state,
      JSON.stringify({ answers, log, counter: join(dir, 'counter') }),
    );
    const result = spawnSync(script, [workflow, sha], {
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
        STUB_GH_STATE: state,
        GITHUB_REPOSITORY: 'o/r',
        WAIT_POLL: '0',
        WAIT_TIMEOUT: timeout,
      },
    });
    return {
      status: result.status,
      out: result.stdout.trim(),
      err: result.stderr,
      queries: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('asks only for push runs on main of that commit and workflow', () => {
  const { queries } = wait([[run(1, 'completed', 'success')]]);
  assert.equal(
    queries[0],
    `repos/o/r/actions/workflows/ci.yml/runs?head_sha=${SHA}&event=push&branch=main&per_page=20`,
  );
});

test('waits while the run is missing, queued, in progress or the API fails, then passes', () => {
  const r = wait([
    [],
    'error',
    [run(1, 'queued')],
    [run(1, 'in_progress')],
    [run(1, 'completed', 'success')],
  ]);
  assert.deepEqual([r.status, r.out, r.queries.length], [0, 'success', 5]);
});

test('a failed, cancelled or timed-out run stops the deploy', () => {
  for (const conclusion of ['failure', 'cancelled', 'timed_out']) {
    const r = wait([[run(1, 'completed', conclusion)]]);
    assert.deepEqual([r.status, r.out], [1, conclusion], conclusion);
  }
});

test('a re-run counts: the newest run decides, and a re-run in progress is waited for', () => {
  // The same id after "Re-run failed jobs": queued again, then green.
  const rerun = wait([
    [run(7, 'in_progress')],
    [run(7, 'completed', 'success')],
  ]);
  assert.deepEqual([rerun.status, rerun.out], [0, 'success']);
  // Two runs for one commit: the newer (higher id) one decides, whatever the order.
  const two = wait([
    [run(9, 'completed', 'success'), run(4, 'completed', 'failure')],
  ]);
  assert.deepEqual([two.status, two.out], [0, 'success']);
  const older = wait([
    [run(4, 'completed', 'success'), run(9, 'completed', 'failure')],
  ]);
  assert.deepEqual([older.status, older.out], [1, 'failure']);
});

test('gives up with `timeout` when the run never finishes', () => {
  const r = wait([[run(1, 'in_progress')]], { timeout: '0' });
  assert.deepEqual([r.status, r.out], [1, 'timeout']);
});

test('refuses a malformed commit or missing arguments', () => {
  assert.equal(wait([[]], { sha: 'main' }).status, 64);
  const none = spawnSync(script, [], {
    encoding: 'utf8',
    env: { GITHUB_REPOSITORY: 'o/r' },
  });
  assert.equal(none.status, 64);
});
