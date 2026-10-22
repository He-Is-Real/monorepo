// The WIF attribute mapping that gates tf-bunny (bunny_gate.cel.tftpl, D57 C), evaluated with a
// CEL engine against GitHub OIDC claim fixtures: only tofu-apply.yml and tofu-drift.yml on main
// get the Bunny keys. PRs never do.
//
//   node --test infra/terraform/modules/bootstrap/tests/
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claims, expression, gate, repository, without } from './claims.mjs';

const bunnyGate = (c) => gate('bunny_gate.cel.tftpl', c);

test('fits the 2048-character attribute-mapping limit', () => {
  assert.ok(expression('bunny_gate.cel.tftpl').length < 2048);
});

const mainRuns = {
  'tofu-apply.yml on push': claims({ event_name: 'push' }),
  'tofu-apply.yml on workflow_dispatch': claims({
    event_name: 'workflow_dispatch',
  }),
  // A run after Release Images plans every root, bunny too (Codex r4 #6).
  'tofu-apply.yml on workflow_run': claims({ event_name: 'workflow_run' }),
  'tofu-drift.yml on schedule': claims({
    workflow: 'tofu-drift.yml',
    event_name: 'schedule',
  }),
  'tofu-drift.yml on workflow_dispatch': claims({
    workflow: 'tofu-drift.yml',
    event_name: 'workflow_dispatch',
  }),
};
for (const [name, c] of Object.entries(mainRuns)) {
  test(`allows ${name}`, () => assert.equal(bunnyGate(c), 'allowed'));
  test(`allows ${name} in the dev environment`, () =>
    assert.equal(
      bunnyGate({
        ...c,
        environment: 'dev',
        sub: `repo:${repository}:environment:dev`,
      }),
      'allowed',
    ));
  test(`allows ${name} without an environment claim`, () =>
    assert.equal(bunnyGate(without(c, 'environment')), 'allowed'));
}

const denied = {
  'pull_request (refs/pull/1/merge)': claims({
    workflow: 'tofu-apply.yml',
    event_name: 'pull_request',
    ref: 'refs/pull/1/merge',
  }),
  'a feature-branch ref': claims({ ref: 'refs/heads/feature' }),
  'tofu-apply.yml@refs/heads/feature with ref main': claims({
    job_workflow_ref: `${repository}/.github/workflows/tofu-apply.yml@refs/heads/feature`,
  }),
  'tofu-drift.yml on push': claims({
    workflow: 'tofu-drift.yml',
    event_name: 'push',
  }),
  'tofu-plan.yml': claims({ workflow: 'tofu-plan.yml' }),
  'tofu-plan.yml on pull_request': claims({
    workflow: 'tofu-plan.yml',
    event_name: 'pull_request',
    ref: 'refs/pull/1/merge',
  }),
  'terraform-apply.yml': claims({
    workflow: 'terraform-apply.yml',
    event_name: 'workflow_dispatch',
  }),
  'ci.yml': claims({ workflow: 'ci.yml' }),
  'tofu-apply.yml on schedule': claims({ event_name: 'schedule' }),
  'another repository': claims({
    job_workflow_ref:
      'someone/monorepo/.github/workflows/tofu-apply.yml@refs/heads/main',
  }),
};
for (const [name, c] of Object.entries(denied)) {
  test(`denies ${name}`, () => assert.equal(bunnyGate(c), 'denied'));
}
