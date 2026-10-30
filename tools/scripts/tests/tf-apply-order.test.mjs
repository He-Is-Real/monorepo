// tofu-apply.yml, wave 1: gcp applies only after bunny (Codex, #117). The bunny root grants
// gcp's services access to keys they read at start-up (api-user's link-signing keys), so a gcp
// apply that starts a revision needing a new grant must wait for it. This evaluates the real
// `if:` of apply-gcp for each way the bunny side can end. Also: one run per merge, and no apply
// unless the merge's CI passed on main (pipeline speed review, P1).
//
//   node --test tools/scripts/tests/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const workflow = parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../.github/workflows/tofu-apply.yml', import.meta.url),
    ),
    'utf8',
  ),
);
const job = workflow.jobs['apply-gcp'];
const images = parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../.github/workflows/images.yml', import.meta.url),
    ),
    'utf8',
  ),
);

/**
 * A GitHub Actions `if:` over `needs` only, evaluated in JavaScript: `always()` is true, values
 * come from `needs`, and every operator it uses (==, &&, ||, parentheses, '…') maps directly.
 */
function evaluate(expression, needs) {
  const allowed = /^[\s\w.()'=&|:-]*$/; // ':' only inside 'blocked: …' strings
  assert.match(expression, allowed, 'unexpected syntax in the condition');
  const js = expression
    .replace(/always\(\)/g, 'true')
    .replace(
      /needs\.([\w-]+)\.(result|outputs\.([\w-]+))/g,
      (_, job, __, output) =>
        JSON.stringify(
          (output ? needs[job]?.outputs?.[output] : needs[job]?.result) ?? '',
        ),
    )
    .replace(/==/g, '===');
  return Function(`"use strict"; return (${js});`)();
}

const gcpReady = {
  target: { result: 'success' },
  ci: { result: 'success' },
  'plan-gcp': { result: 'success', outputs: { changes: 'true' } },
  'approve-1': { result: 'success', outputs: { go: 'true' } },
};
const bunny = (plan, changes, apply) => ({
  ...gcpReady,
  'plan-bunny': { result: plan, outputs: { changes } },
  'apply-bunny': { result: apply },
});

test('apply-gcp waits for apply-bunny', () => {
  for (const need of ['plan-bunny', 'apply-bunny'])
    assert.ok(job.needs.includes(need), `apply-gcp must need ${need}`);
});

test('gcp applies once bunny applied, or had nothing to change', () => {
  assert.equal(evaluate(job.if, bunny('success', 'true', 'success')), true);
  assert.equal(evaluate(job.if, bunny('success', 'false', 'skipped')), true);
});

test('a failed or cancelled bunny plan or apply holds gcp back', () => {
  for (const [plan, changes, apply] of [
    ['success', 'true', 'failure'],
    ['success', 'true', 'cancelled'],
    ['failure', '', 'skipped'],
    ['cancelled', '', 'skipped'],
  ])
    assert.equal(
      evaluate(job.if, bunny(plan, changes, apply)),
      false,
      `bunny plan ${plan}, apply ${apply}`,
    );
});

test('gcp still needs its own changes, the approval and go', () => {
  const ok = bunny('success', 'false', 'skipped');
  for (const broken of [
    { 'plan-gcp': { result: 'success', outputs: { changes: 'false' } } },
    { 'plan-gcp': { result: 'failure', outputs: {} } },
    { 'approve-1': { result: 'success', outputs: { go: 'false' } } },
    { 'approve-1': { result: 'skipped', outputs: {} } },
  ])
    assert.equal(evaluate(job.if, { ...ok, ...broken }), false);
});

test('one run per merge: Release Images on every push to main starts the deploy', () => {
  assert.deepEqual(Object.keys(workflow.on).sort(), [
    'workflow_dispatch',
    'workflow_run',
  ]);
  assert.deepEqual(workflow.on.workflow_run, {
    workflows: ['Release Images'],
    types: ['completed'],
    branches: ['main'],
  });
  // No paths filter on Release Images: every merge must reach a deploy run.
  assert.deepEqual(Object.keys(images.on), ['push']);
  assert.deepEqual(images.on.push, { branches: ['main'] });
});

// Each apply job with everything else ready to apply.
const ready = {
  'apply-gcp': bunny('success', 'false', 'skipped'),
  'apply-bunny': {
    'plan-bunny': { result: 'success', outputs: { changes: 'true' } },
    'approve-1': { result: 'success', outputs: { go: 'true' } },
  },
  'apply-stripe': {
    'plan-stripe': { result: 'success', outputs: { changes: 'true' } },
    'approve-1': { result: 'success', outputs: { go: 'true' } },
  },
  'apply-cluster': {
    'plan-cluster': { result: 'success', outputs: { changes: 'true' } },
    'approve-2': { result: 'success', outputs: { go: 'true' } },
  },
  'apply-images': {
    'plan-images': { result: 'success', outputs: { changes: 'true' } },
    'approve-2': { result: 'success', outputs: { go: 'true' } },
  },
};

test('every apply job is listed here', () => {
  assert.deepEqual(
    Object.keys(workflow.jobs)
      .filter((name) => name.startsWith('apply-'))
      .sort(),
    Object.keys(ready).sort(),
  );
});

test('nothing applies unless CI passed on main for the target', () => {
  for (const [name, needs] of Object.entries(ready)) {
    const apply = workflow.jobs[name];
    assert.ok(apply.needs.includes('ci'), `${name} must need ci`);
    assert.equal(
      evaluate(apply.if, { ...needs, ci: { result: 'success' } }),
      true,
      `${name} with CI green`,
    );
    for (const ci of ['failure', 'cancelled', 'skipped', ''])
      assert.equal(
        evaluate(apply.if, { ...needs, ci: { result: ci } }),
        false,
        `${name} with CI ${ci || 'missing'}`,
      );
  }
});

test("a failed CI blocks wave 1's stages, and so wave 2 and the behavioural tests", () => {
  for (const root of ['gcp', 'bunny', 'stripe']) {
    const stage = workflow.jobs[`stage-${root}`];
    assert.ok(stage.needs.includes('ci'), `stage-${root} must need ci`);
    const prev = stage.steps.find((s) => s.id === 'stage').env.PREV;
    const value = (ci) =>
      evaluate(prev.replace(/^\$\{\{\s*|\s*\}\}$/g, ''), {
        target: { result: 'success' },
        ci: { result: ci },
      });
    assert.equal(value('success'), 'ok', `stage-${root}`);
    assert.notEqual(value('failure'), 'ok', `stage-${root}`);
  }
});
