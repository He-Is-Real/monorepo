// tofu-apply.yml, wave 1: gcp applies only after bunny (Codex, #117). The bunny root grants
// gcp's services access to keys they read at start-up (api-user's link-signing keys), so a gcp
// apply that starts a revision needing a new grant must wait for it. This evaluates the real
// `if:` of apply-gcp for each way the bunny side can end.
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

/**
 * A GitHub Actions `if:` over `needs` only, evaluated in JavaScript: `always()` is true, values
 * come from `needs`, and every operator it uses (==, &&, ||, parentheses, '…') maps directly.
 */
function evaluate(expression, needs) {
  const allowed = /^[\s\w.()'=&|-]*$/;
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
