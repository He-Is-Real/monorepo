// tofu-apply.yml's `pending` step (tools/scripts/tf-pending.sh): did an earlier run apply
// something that "Dev behavioural tests" hasn't tested yet? Run as Actions runs it, against a stub
// `gh` that serves the runs API from a fixture, paged as GitHub pages it. Codex review of #94:
// an untested apply pushed out of the first page was forgotten, and a re-run of an older
// behavioural run didn't count as the tests' latest start.
//
//   node --test tools/scripts/tests/
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const repo = fileURLToPath(new URL('../../..', import.meta.url));
const pendingStep = parse(
  readFileSync(join(repo, '.github/workflows/tofu-apply.yml'), 'utf8'),
).jobs.behavioural.steps.find((s) => s.id === 'pending');

// `gh api repos/o/r/actions/<path> --jq <expr>`: lists runs newest first, sliced by per_page
// (default 30) and page; a run's jobs; any path in `fail` is an API error.
const STUB_GH = `#!/usr/bin/env node
const { execFileSync } = require('node:child_process');
const state = JSON.parse(require('node:fs').readFileSync(process.env.STUB_GH_STATE, 'utf8'));
const [, path, flag, expr] = process.argv.slice(2);
const url = new URL(path.replace(/^repos\\/[^/]+\\/[^/]+\\/actions\\//, ''), 'https://x/');
if (state.fail.some((f) => url.pathname.slice(1) + url.search === f)) process.exit(1);
let body;
const workflow = /^\\/workflows\\/([^/]+)\\/runs$/.exec(url.pathname);
const jobs = /^\\/runs\\/(\\d+)\\/jobs$/.exec(url.pathname);
if (workflow) {
  const perPage = Number(url.searchParams.get('per_page') ?? 30);
  const page = Number(url.searchParams.get('page') ?? 1);
  const runs = [...state.runs[workflow[1]]].sort((a, b) => b.created_at.localeCompare(a.created_at));
  body = { workflow_runs: runs.slice((page - 1) * perPage, page * perPage) };
} else if (jobs) {
  body = { jobs: state.jobs[jobs[1]] ?? [] };
} else process.exit(1);
if (flag !== '--jq') process.exit(2);
process.stdout.write(execFileSync('jq', ['-r', expr], { input: JSON.stringify(body) }));
`;

const t = (minute) =>
  new Date(Date.UTC(2026, 9, 25, 0, minute)).toISOString().replace('.000', '');
const behaviouralRun = (id, created, started = created) => ({
  id,
  created_at: t(created),
  run_started_at: t(started),
  updated_at: t(started + 5),
});
const applyRun = (id, minute) => ({
  id,
  created_at: t(minute),
  run_started_at: t(minute),
  updated_at: t(minute + 1),
});
const appliedJob = (minute) => ({
  name: 'apply-cluster',
  conclusion: 'success',
  completed_at: t(minute),
});

const THIS_RUN = 999999;

/** The step's `pending` output, given both workflows' runs and the jobs of each apply run. */
function pending({ behavioural, tofu, jobs = {}, fail = [] }) {
  const dir = mkdtempSync(join(tmpdir(), 'tf-pending-'));
  try {
    const bin = join(dir, 'bin');
    spawnSync('mkdir', [bin]);
    writeFileSync(join(bin, 'gh'), STUB_GH);
    chmodSync(join(bin, 'gh'), 0o755);
    const state = join(dir, 'state.json');
    writeFileSync(
      state,
      JSON.stringify({
        runs: {
          'dev-behavioural-tests.yml': behavioural,
          'tofu-apply.yml': [applyRun(THIS_RUN, 10_000), ...tofu],
        },
        jobs,
        fail,
      }),
    );
    const output = join(dir, 'output');
    const result = spawnSync('bash', ['-e', '-c', pendingStep.run], {
      cwd: repo,
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
        STUB_GH_STATE: state,
        GITHUB_REPOSITORY: 'o/r',
        GITHUB_RUN_ID: String(THIS_RUN),
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: join(dir, 'summary'),
      },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return /^pending=(.*)$/m.exec(readFileSync(output, 'utf8'))?.[1];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 100 runs that applied nothing, after minute `from`.
const idleRuns = (from) =>
  Array.from({ length: 100 }, (_, i) => applyRun(1000 + i, from + 10 * i));

test('an earlier run applied after the tests last started → pending', () => {
  assert.equal(
    pending({
      behavioural: [behaviouralRun(1, 0)],
      tofu: [applyRun(10, 20)],
      jobs: { 10: [appliedJob(21)] },
    }),
    'true',
  );
});

test('nothing applied since the tests last started → not pending', () => {
  assert.equal(
    pending({
      behavioural: [behaviouralRun(1, 30)],
      tofu: [applyRun(10, 20)],
      jobs: { 10: [appliedJob(21)] },
    }),
    'false',
  );
});

test('an untested apply behind 100 newer runs that applied nothing → pending', () => {
  assert.equal(
    pending({
      behavioural: [behaviouralRun(1, 0)],
      tofu: [applyRun(10, 20), ...idleRuns(100)],
      jobs: { 10: [appliedJob(21)] },
    }),
    'true',
  );
});

test('a re-run of an older behavioural run started after the apply → not pending', () => {
  assert.equal(
    pending({
      // Run 2 is the newest, but run 1 was re-run later, after run 10 applied.
      behavioural: [behaviouralRun(1, 0, 40), behaviouralRun(2, 10)],
      tofu: [applyRun(10, 20)],
      jobs: { 10: [appliedJob(21)] },
    }),
    'false',
  );
});

test('history that can’t be read back to the tests’ last start → pending', () => {
  assert.equal(
    pending({
      behavioural: [behaviouralRun(1, 0)],
      tofu: [...idleRuns(100), applyRun(10, 20)],
      fail: ['workflows/tofu-apply.yml/runs?per_page=100&page=2'],
    }),
    'true',
  );
});

test('the behavioural runs can’t be listed → pending', () => {
  assert.equal(
    pending({
      behavioural: [behaviouralRun(1, 0)],
      tofu: [],
      fail: ['workflows/dev-behavioural-tests.yml/runs?per_page=100'],
    }),
    'true',
  );
});

test('the tests never ran, and no run applied anything → not pending', () => {
  assert.equal(pending({ behavioural: [], tofu: [applyRun(10, 20)] }), 'false');
});
