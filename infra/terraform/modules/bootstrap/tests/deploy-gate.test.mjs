// The WIF attribute mapping that gates tf-deployer (deploy_gate.cel.tftpl), evaluated with a
// CEL engine against GitHub OIDC claim fixtures: tofu-apply.yml and tofu-drift.yml on main only.
//
//   node --test infra/terraform/modules/bootstrap/tests/
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claims, expression, gate, repository } from './claims.mjs';

const deployGate = (c) => gate('deploy_gate.cel.tftpl', c);

test('fits the 2048-character attribute-mapping limit', () => {
  assert.ok(expression('deploy_gate.cel.tftpl').length < 2048);
});

const allowed = {
  'tofu-apply.yml on push': claims({ event_name: 'push' }),
  'tofu-apply.yml on workflow_dispatch': claims({
    event_name: 'workflow_dispatch',
  }),
  'tofu-apply.yml on workflow_run': claims({ event_name: 'workflow_run' }),
  'tofu-apply.yml in the dev environment': claims({
    environment: 'dev',
    sub: `repo:${repository}:environment:dev`,
  }),
  'tofu-drift.yml on schedule': claims({
    workflow: 'tofu-drift.yml',
    event_name: 'schedule',
  }),
  'tofu-drift.yml on workflow_dispatch': claims({
    workflow: 'tofu-drift.yml',
    event_name: 'workflow_dispatch',
  }),
};
for (const [name, c] of Object.entries(allowed)) {
  test(`allows ${name}`, () => assert.equal(deployGate(c), 'allowed'));
}

const denied = {
  pull_request: claims({
    event_name: 'pull_request',
    ref: 'refs/pull/1/merge',
  }),
  'a non-main ref': claims({ ref: 'refs/heads/feature' }),
  'tofu-apply.yml from a feature branch, ref main': claims({
    job_workflow_ref: `${repository}/.github/workflows/tofu-apply.yml@refs/heads/feature`,
  }),
  'tofu-plan.yml': claims({ workflow: 'tofu-plan.yml' }),
  'tofu-drift.yml on push': claims({
    workflow: 'tofu-drift.yml',
    event_name: 'push',
  }),
  'terraform-apply.yml on push': claims({ workflow: 'terraform-apply.yml' }),
  // The old manual workflow, deleted in PR 2; its clause went at L5.
  'terraform-apply.yml on workflow_dispatch': claims({
    workflow: 'terraform-apply.yml',
    event_name: 'workflow_dispatch',
  }),
  'tofu-apply.yml on schedule': claims({ event_name: 'schedule' }),
  'tofu-apply.yml on pull_request_target': claims({
    event_name: 'pull_request_target',
  }),
  'another repository': claims({
    job_workflow_ref:
      'someone/monorepo/.github/workflows/tofu-apply.yml@refs/heads/main',
  }),
};
for (const [name, c] of Object.entries(denied)) {
  test(`denies ${name}`, () => assert.equal(deployGate(c), 'denied'));
}
