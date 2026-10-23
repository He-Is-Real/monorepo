// tools/scripts/tf-superseded.sh and tofu-apply.yml's `superseded` job (Joel, 2026-10-23): a run
// whose approved plan was superseded warns and ends red, never as a green tick.
//
//   node --test tools/scripts/tests/
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const script = fileURLToPath(new URL('../tf-superseded.sh', import.meta.url));
const workflow = parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../.github/workflows/tofu-apply.yml', import.meta.url),
    ),
    'utf8',
  ),
);

// message(go1, go2, newer_run)
const message = (...args) => {
  const result = spawnSync(script, args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout.trim();
};

test('wave 1 superseded → nothing applied, names the newer run', () => {
  assert.equal(
    message('false', '', '57'),
    'Superseded by run 57: nothing applied; the newer run plans main HEAD.',
  );
});

test('wave 2 superseded after wave 1 applied → says what was applied', () => {
  assert.equal(
    message('true', 'false', '58'),
    'Superseded by run 58: wave 1 (gcp, bunny) applied, wave 2 (cluster, images) not; the newer run plans main HEAD.',
  );
});

test('wave 2 superseded, wave 1 had no changes → nothing applied', () => {
  assert.equal(
    message('', 'false', '59'),
    'Superseded by run 59: nothing applied; the newer run plans main HEAD.',
  );
});

test('newer run not found → still a clear message', () => {
  assert.equal(
    message('false', '', ''),
    'Superseded by a newer run: nothing applied; the newer run plans main HEAD.',
  );
});

test('not superseded → nothing', () => {
  assert.equal(message('true', 'true', '60'), '');
  assert.equal(message('true', '', '60'), '');
  assert.equal(message('', '', ''), '');
});

test('usage error → exit 64', () => {
  assert.equal(spawnSync(script, ['false'], { encoding: 'utf8' }).status, 64);
});

const job = workflow.jobs.superseded;

test('tofu-apply.yml: the superseded job runs last, only when an approval was superseded', () => {
  assert.ok(job, 'no superseded job');
  for (const need of [
    'approve-1',
    'approve-2',
    'stage-gcp',
    'stage-bunny',
    'stage-cluster',
    'stage-images',
  ])
    assert.ok(job.needs.includes(need), `superseded must wait for ${need}`);
  assert.match(job.if, /^always\(\) && /);
  assert.match(job.if, /needs\.approve-1\.outputs\.go == 'false'/);
  assert.match(job.if, /needs\.approve-2\.outputs\.go == 'false'/);
});

test('tofu-apply.yml: the superseded job warns, writes the summary and fails', () => {
  const run = job.steps.map((s) => s.run ?? '').join('\n');
  assert.match(run, /::warning title=Superseded::/);
  assert.match(run, /GITHUB_STEP_SUMMARY/);
  assert.match(run, /tf-superseded\.sh/);
  assert.match(run, /exit 1\s*$/);
});

test('tofu-apply.yml: the superseded job asks only to read', () => {
  assert.deepEqual(job.permissions, { contents: 'read', actions: 'read' });
  assert.ok(
    !('environment' in job),
    'no environment: it must never need an approval',
  );
});

test('tofu-apply.yml: no job is called `main` (the required check’s name)', () => {
  assert.ok(!('main' in workflow.jobs));
});

test('tofu-apply.yml: both approve jobs warn when superseded', () => {
  for (const name of ['approve-1', 'approve-2']) {
    const run = workflow.jobs[name].steps.map((s) => s.run ?? '').join('\n');
    assert.match(run, /::warning title=Superseded::superseded by \$main/);
    assert.match(run, /echo go=false/);
  }
});
