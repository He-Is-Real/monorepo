// The WIF attribute mapping that gates ci-dev-seeder (dev_seed_gate.cel.tftpl, D50), evaluated
// with a CEL engine against GitHub OIDC claim fixtures: only "Reset dev data" and "Dev
// behavioural tests", dispatched on main, may start dev-seed.
//
//   node --test infra/terraform/modules/bootstrap/tests/
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claims, expression, gate, repository } from './claims.mjs';

const devSeedGate = (c) => gate('dev_seed_gate.cel.tftpl', c);
const ref = (file, branch = 'refs/heads/main') =>
  `${repository}/.github/workflows/${file}@${branch}`;
const dispatched = (overrides = {}) =>
  claims({
    workflow: 'reset-dev-data.yml',
    event_name: 'workflow_dispatch',
    ...overrides,
  });

test('fits the 2048-character attribute-mapping limit', () => {
  assert.ok(expression('dev_seed_gate.cel.tftpl').length < 2048);
});

const allowed = {
  'Reset dev data, dispatched on main': dispatched(),
  'Dev behavioural tests, dispatched on main': dispatched({
    workflow: 'dev-behavioural-tests.yml',
  }),
};
for (const [name, c] of Object.entries(allowed)) {
  test(`allows ${name}`, () => assert.equal(devSeedGate(c), 'allowed'));
}

const denied = {
  'a dispatch on another branch': dispatched({
    ref: 'refs/heads/feature',
    workflow_ref: ref('reset-dev-data.yml', 'refs/heads/feature'),
    job_workflow_ref: ref('reset-dev-data.yml', 'refs/heads/feature'),
  }),
  'branch code of the reset workflow, ref main': dispatched({
    job_workflow_ref: ref('reset-dev-data.yml', 'refs/heads/feature'),
  }),
  'a push to main': dispatched({ event_name: 'push' }),
  'a schedule': dispatched({ event_name: 'schedule' }),
  'a pull request': dispatched({
    event_name: 'pull_request',
    ref: 'refs/pull/1/merge',
  }),
  pull_request_target: dispatched({ event_name: 'pull_request_target' }),
  'the reset workflow called as a reusable workflow': dispatched({
    workflow_ref: ref('dev-behavioural-tests.yml'),
  }),
  'another workflow calling it': dispatched({
    workflow_ref: ref('tofu-apply.yml'),
  }),
  'snapshot-images.yml': claims({
    workflow: 'snapshot-images.yml',
    event_name: 'workflow_dispatch',
  }),
  'tofu-apply.yml': claims({ event_name: 'workflow_dispatch' }),
  'another repository': dispatched({
    job_workflow_ref:
      'someone/monorepo/.github/workflows/reset-dev-data.yml@refs/heads/main',
    workflow_ref:
      'someone/monorepo/.github/workflows/reset-dev-data.yml@refs/heads/main',
  }),
};
for (const [name, c] of Object.entries(denied)) {
  test(`denies ${name}`, () => assert.equal(devSeedGate(c), 'denied'));
}
