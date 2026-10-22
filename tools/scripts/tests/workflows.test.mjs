// Workflow hygiene for a public repository (D57): every workflow starts from no permissions and
// each job asks for what it uses; jobs that sign in to Google (directly, through a local action
// or through a local reusable workflow) ask for an OIDC token themselves; pull_request_target
// (fork code with this repository's secrets) is never a trigger.
//
//   node --test tools/scripts/tests/*.test.mjs
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const repo = fileURLToPath(new URL('../../..', import.meta.url));
const dir = join(repo, '.github/workflows');
const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
const load = (path) => parse(readFileSync(path, 'utf8'));
const workflows = Object.fromEntries(files.map((f) => [f, load(join(dir, f))]));

const AUTH = 'google-github-actions/auth@';

// Does a `uses:` reference sign in to Google, following local actions and reusable workflows?
const signsIn = (uses, seen = new Set()) => {
  if (typeof uses !== 'string') return false;
  if (uses.startsWith(AUTH)) return true;
  if (!uses.startsWith('./') || seen.has(uses)) return false;
  seen.add(uses);
  const path = join(repo, uses.split('@')[0]);
  if (/\.ya?ml$/.test(path)) {
    const jobs = Object.values(load(path).jobs ?? {});
    return jobs.some((job) => jobSignsIn(job, seen));
  }
  const action = ['action.yml', 'action.yaml']
    .map((f) => join(path, f))
    .find(existsSync);
  if (!action) return false;
  return (load(action).runs?.steps ?? []).some((step) =>
    signsIn(step.uses, seen),
  );
};
const jobSignsIn = (job, seen = new Set()) =>
  signsIn(job.uses, seen) ||
  (job.steps ?? []).some((step) => signsIn(step.uses, seen));

const triggers = (on) =>
  typeof on === 'string'
    ? [on]
    : Array.isArray(on)
      ? on
      : Object.keys(on ?? {});

test('there are workflows to check', () => {
  assert.ok(files.length > 0);
});

for (const [file, workflow] of Object.entries(workflows)) {
  test(`${file}: top-level permissions are {}`, () => {
    assert.ok('permissions' in workflow, 'no top-level permissions');
    assert.deepEqual(workflow.permissions, {});
  });

  test(`${file}: no pull_request_target`, () => {
    assert.ok(!triggers(workflow.on).includes('pull_request_target'));
  });

  for (const [name, job] of Object.entries(workflow.jobs ?? {})) {
    if (!jobSignsIn(job)) continue;
    test(`${file}: job ${name} signs in to Google, so asks for id-token: write`, () => {
      assert.equal(job.permissions?.['id-token'], 'write');
    });
  }
}
