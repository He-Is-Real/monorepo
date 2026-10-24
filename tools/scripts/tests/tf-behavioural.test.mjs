// tools/scripts/tf-behavioural.sh: tofu-apply.yml dispatches "Dev behavioural tests" only after a
// complete deploy (Codex review of #73: never after a partial one, which would reset dev data and
// test a half-deployed system). Each scenario runs the real tf-stage.sh on the jobs' results,
// wired as tofu-apply.yml wires them, then the decision.
//
//   node --test tools/scripts/tests/
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const script = (name) => fileURLToPath(new URL(`../${name}`, import.meta.url));
const sh = (name, args) => {
  const result = spawnSync(script(name), args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout.trim();
};
const stage = (prev, selected, plan, changes, go, apply) =>
  sh('tf-stage.sh', [prev, selected, plan, changes, go, apply]);

/**
 * One tofu-apply run: each root's plan result, changes output and apply result, and the two
 * approvals' results and `go` outputs. Unset roots planned "no changes".
 */
function decide({
  approve1 = { result: 'skipped', go: '' },
  approve2 = { result: 'skipped', go: '' },
  images = false, // dispatched with `images`
  ...roots
}) {
  const r = (name) => ({
    plan: 'success',
    changes: 'false',
    apply: 'skipped',
    ...roots[name],
  });
  const [gcp, bunny, cluster, imgs] = ['gcp', 'bunny', 'cluster', 'images'].map(
    r,
  );
  const stageGcp = stage(
    'ok',
    'true',
    gcp.plan,
    gcp.changes,
    approve1.go,
    gcp.apply,
  );
  const stageBunny = stage(
    'ok',
    'true',
    bunny.plan,
    bunny.changes,
    approve1.go,
    bunny.apply,
  );
  // Wave 2 starts only if wave 1 is ok and approve-1 was skipped or approved (tofu-apply.yml).
  const wave1 =
    stageGcp === 'ok' &&
    (approve1.result === 'skipped' ||
      (approve1.result === 'success' && approve1.go === 'true'))
      ? 'ok'
      : 'blocked: wave 1';
  const stageCluster = stage(
    wave1,
    'true',
    cluster.plan,
    cluster.changes,
    approve2.go,
    cluster.apply,
  );
  const stageImages = stage(
    wave1,
    String(images),
    imgs.plan,
    imgs.changes,
    approve2.go,
    imgs.apply,
  );
  return sh('tf-behavioural.sh', [
    stageGcp,
    stageBunny,
    stageCluster,
    stageImages,
    '--',
    gcp.apply,
    bunny.apply,
    cluster.apply,
    imgs.apply,
  ]);
}

const applied = { plan: 'success', changes: 'true', apply: 'success' };
const approved = { result: 'success', go: 'true' };

test('full success (gcp, then cluster) → dispatch', () => {
  assert.equal(
    decide({
      gcp: applied,
      cluster: applied,
      approve1: approved,
      approve2: approved,
    }),
    'dispatch',
  );
});

test('only gcp changed and applied → dispatch', () => {
  assert.equal(decide({ gcp: applied, approve1: approved }), 'dispatch');
});

test('no changes anywhere → no dispatch', () => {
  assert.equal(decide({}), 'skip: nothing was applied');
});

test('gcp applied, then the cluster plan failed → no dispatch', () => {
  assert.match(
    decide({
      gcp: applied,
      approve1: approved,
      cluster: { plan: 'failure', changes: '', apply: 'skipped' },
    }),
    /^skip: a stage is blocked: plan failure/,
  );
});

test('gcp applied, wave 2 rejected (approve-2 failed, go empty) → no dispatch', () => {
  assert.match(
    decide({
      gcp: applied,
      approve1: approved,
      cluster: { plan: 'success', changes: 'true', apply: 'skipped' },
      approve2: { result: 'failure', go: '' },
    }),
    /^skip: a stage is blocked: superseded or rejected/,
  );
});

test('superseded after wave 1 (go false) → no dispatch', () => {
  assert.match(
    decide({
      gcp: { plan: 'success', changes: 'true', apply: 'skipped' },
      approve1: { result: 'success', go: 'false' },
    }),
    /^skip: a stage is blocked/,
  );
});

test('superseded in wave 2 after gcp applied → no dispatch', () => {
  assert.match(
    decide({
      gcp: applied,
      approve1: approved,
      cluster: { plan: 'success', changes: 'true', apply: 'skipped' },
      approve2: { result: 'success', go: 'false' },
    }),
    /^skip: a stage is blocked: superseded or rejected/,
  );
});

test('gcp applied, bunny apply failed → no dispatch', () => {
  assert.match(
    decide({
      gcp: applied,
      bunny: { plan: 'success', changes: 'true', apply: 'failure' },
      approve1: approved,
    }),
    /^skip: a stage is blocked: apply failure/,
  );
});

test('a cancelled cluster apply → no dispatch', () => {
  assert.match(
    decide({
      gcp: applied,
      approve1: approved,
      cluster: { plan: 'success', changes: 'true', apply: 'cancelled' },
      approve2: approved,
    }),
    /^skip: a stage is blocked: apply cancelled/,
  );
});

test('a missing stage result (the stage job never ran) → no dispatch', () => {
  assert.equal(
    sh('tf-behavioural.sh', [
      'ok',
      '',
      'ok',
      'ok',
      '--',
      'success',
      'skipped',
      'skipped',
      'skipped',
    ]),
    'skip: a stage is missing',
  );
});

test('usage errors exit 64', () => {
  const result = spawnSync(script('tf-behavioural.sh'), ['ok', '--', 'x'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 64);
});

test('tofu-apply.yml feeds every stage and apply to it, and dispatches only on its word', () => {
  const workflow = parse(
    readFileSync(
      fileURLToPath(
        new URL('../../../.github/workflows/tofu-apply.yml', import.meta.url),
      ),
      'utf8',
    ),
  );
  const job = workflow.jobs.behavioural;
  const roots = ['gcp', 'bunny', 'cluster', 'images'];
  for (const root of roots) {
    assert.ok(job.needs.includes(`stage-${root}`), `needs stage-${root}`);
    assert.ok(job.needs.includes(`apply-${root}`), `needs apply-${root}`);
    assert.match(
      workflow.jobs[`stage-${root}`].outputs?.result ?? '',
      /steps\.stage\.outputs\.result/,
      `stage-${root} publishes its result`,
    );
  }
  const decide = job.steps.find((s) => s.id === 'decide');
  for (const root of roots) {
    assert.match(
      decide.env[`STAGE_${root.toUpperCase()}`],
      new RegExp(`needs\\.stage-${root}\\.outputs\\.result`),
    );
    assert.match(
      decide.env[`APPLY_${root.toUpperCase()}`],
      new RegExp(`needs\\.apply-${root}\\.result`),
    );
  }
  assert.match(decide.run, /tf-behavioural\.sh/);
  const dispatch = job.steps.find((s) => /gh workflow run/.test(s.run ?? ''));
  assert.equal(dispatch.if, "steps.decide.outputs.decision == 'dispatch'");
});

// The workflow's own decide step, run as Actions runs it: its `run` script under bash with the
// step's env, a stage output that was never published simply absent (Codex review of #73,
// round 2: a comma-joined list lost its trailing empty value and dispatched).
const repo = fileURLToPath(new URL('../../..', import.meta.url));
const decideStep = parse(
  readFileSync(join(repo, '.github/workflows/tofu-apply.yml'), 'utf8'),
).jobs.behavioural.steps.find((s) => s.id === 'decide');
function runDecideStep(env) {
  const dir = mkdtempSync(join(tmpdir(), 'tf-behavioural-'));
  try {
    const output = join(dir, 'output');
    const result = spawnSync('bash', ['-e', '-c', decideStep.run], {
      cwd: repo,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: join(dir, 'summary'),
        ...env,
      },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return /^decision=(.*)$/m.exec(readFileSync(output, 'utf8'))?.[1];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the decide step reads every value it needs from its own env', () => {
  const names = Object.keys(decideStep.env);
  for (const root of ['GCP', 'BUNNY', 'CLUSTER', 'IMAGES'])
    for (const kind of ['STAGE', 'APPLY'])
      assert.ok(names.includes(`${kind}_${root}`), `${kind}_${root}`);
});

test('the decide step: images stage never published (its job failed early) → no dispatch', () => {
  const decision = runDecideStep({
    STAGE_GCP: 'ok',
    STAGE_BUNNY: 'ok',
    STAGE_CLUSTER: 'ok',
    // STAGE_IMAGES: absent, as when stage-images fails before writing its output
    APPLY_GCP: 'success',
    APPLY_BUNNY: 'skipped',
    APPLY_CLUSTER: 'success',
    APPLY_IMAGES: 'failure',
  });
  assert.equal(decision, 'skip: a stage is missing');
});

test('the decide step: every stage ok and an apply done → dispatch', () => {
  assert.equal(
    runDecideStep({
      STAGE_GCP: 'ok',
      STAGE_BUNNY: 'ok',
      STAGE_CLUSTER: 'ok',
      STAGE_IMAGES: 'ok',
      APPLY_GCP: 'success',
      APPLY_BUNNY: 'skipped',
      APPLY_CLUSTER: 'success',
      APPLY_IMAGES: 'skipped',
    }),
    'dispatch',
  );
});

test('fewer or more than four values is a usage error, never a decision', () => {
  for (const args of [
    ['ok', 'ok', 'ok', '--', 'success', 'skipped', 'success', 'failure'],
    [
      'ok',
      'ok',
      'ok',
      'ok',
      'ok',
      '--',
      'success',
      'skipped',
      'success',
      'failure',
    ],
    ['ok', 'ok', 'ok', 'ok', '--', 'success', 'skipped', 'success'],
  ]) {
    const result = spawnSync(script('tf-behavioural.sh'), args, {
      encoding: 'utf8',
    });
    assert.equal(result.status, 64, args.join(' '));
  }
});
