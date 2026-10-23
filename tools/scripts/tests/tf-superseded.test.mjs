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

// superseded(newer_run, ...roots) → [message, advice]; each root is `name=plan,changes,apply`
// (the plan job's result and `changes` output, the apply job's result).
const superseded = (...args) => {
  const result = spawnSync(script, args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout.trimEnd().split('\n');
};
const NOT_RUN = ',,';

test('wave 1 superseded → nothing applied, names the newer run', () => {
  assert.deepEqual(
    superseded(
      '57',
      'gcp=success,true,skipped',
      'bunny=success,false,skipped',
      `cluster=${NOT_RUN}`,
      `images=${NOT_RUN}`,
    ),
    [
      'Superseded by run 57: nothing applied; the newer run plans main HEAD.',
      'Nothing failed: no action is needed.',
    ],
  );
});

test('wave 2 superseded after wave 1 applied → says exactly what applied', () => {
  assert.deepEqual(
    superseded(
      '58',
      'gcp=success,true,success',
      'bunny=success,true,success',
      'cluster=success,true,skipped',
      'images=skipped,,skipped',
    ),
    [
      'Superseded by run 58: applied: gcp, bunny; not applied: cluster; the newer run plans main HEAD.',
      'Nothing failed: no action is needed.',
    ],
  );
});

test('a failed apply is named and never called fine (Codex, #61)', () => {
  const [message, advice] = superseded(
    '59',
    'gcp=success,true,success',
    'bunny=success,true,failure',
    'cluster=success,true,skipped',
    `images=${NOT_RUN}`,
  );
  assert.equal(
    message,
    'Superseded by run 59: applied: gcp; failed: bunny; not applied: cluster; the newer run plans main HEAD.',
  );
  assert.match(advice, /^Failed: bunny\. /);
  assert.doesNotMatch(advice, /no action is needed|Nothing (failed|is broken)/);
});

test('a failed or cancelled plan counts as failed', () => {
  const [message, advice] = superseded(
    '60',
    'gcp=success,true,success',
    'bunny=failure,,skipped',
    'cluster=success,true,cancelled',
    `images=${NOT_RUN}`,
  );
  assert.equal(
    message,
    'Superseded by run 60: applied: gcp; failed: bunny, cluster; the newer run plans main HEAD.',
  );
  assert.match(advice, /^Failed: bunny, cluster\. /);
  assert.match(advice, /may have changed some resources/); // cluster's apply was cancelled
});

test('nothing applied but something failed → says so', () => {
  const [message, advice] = superseded(
    '61',
    'gcp=success,true,skipped',
    'bunny=failure,,skipped',
    `cluster=${NOT_RUN}`,
    `images=${NOT_RUN}`,
  );
  assert.equal(
    message,
    'Superseded by run 61: nothing applied; failed: bunny; not applied: gcp; the newer run plans main HEAD.',
  );
  assert.match(advice, /^Failed: bunny\. /);
});

test('an apply that started and failed is not "nothing applied" (Codex, #61)', () => {
  const [message, advice] = superseded(
    '62',
    'gcp=success,false,skipped',
    'bunny=success,true,failure',
    'cluster=success,true,skipped',
    `images=${NOT_RUN}`,
  );
  assert.equal(
    message,
    'Superseded by run 62: no apply completed; failed: bunny; not applied: cluster; the newer run plans main HEAD.',
  );
  assert.doesNotMatch(message, /nothing applied/);
  assert.match(advice, /^Failed: bunny\. /);
  assert.match(advice, /may have changed some resources/);
});

test('only failed plans → no apply started, so no partial-change note', () => {
  const [, advice] = superseded(
    '63',
    'gcp=failure,,skipped',
    `bunny=${NOT_RUN}`,
  );
  assert.doesNotMatch(advice, /may have changed/);
});

test('newer run not found → still a clear message', () => {
  assert.equal(
    superseded('', 'gcp=success,true,skipped')[0],
    'Superseded by a newer run: nothing applied; the newer run plans main HEAD.',
  );
});

test('usage errors → exit 64', () => {
  for (const args of [[], ['57'], ['57', 'gcp'], ['57', 'gcp=a,b']])
    assert.equal(spawnSync(script, args, { encoding: 'utf8' }).status, 64);
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

test('tofu-apply.yml: the superseded job is given every root’s plan and apply results', () => {
  const run = job.steps.map((s) => s.run ?? '').join('\n');
  const env = job.steps
    .map((s) => s.env ?? {})
    .reduce((a, e) => ({ ...a, ...e }), {});
  for (const root of ['gcp', 'bunny', 'cluster', 'images']) {
    assert.ok(job.needs.includes(`plan-${root}`), `needs plan-${root}`);
    assert.ok(job.needs.includes(`apply-${root}`), `needs apply-${root}`);
    const value = env[root.toUpperCase()];
    assert.equal(
      value,
      `\${{ needs.plan-${root}.result }},\${{ needs.plan-${root}.outputs.changes }},\${{ needs.apply-${root}.result }}`,
    );
    assert.match(run, new RegExp(`"${root}=\\$${root.toUpperCase()}"`));
  }
  assert.doesNotMatch(run, /Nothing is broken/);
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
