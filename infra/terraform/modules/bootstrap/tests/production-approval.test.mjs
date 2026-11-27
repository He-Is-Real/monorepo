// BE-18: outside dev, the deploy and bunny gates are wrapped in production_approval.cel.tftpl, so
// tofu-apply.yml gets tf-deployer or tf-bunny only in a job in the `production` GitHub
// environment (which has a required reviewer). Drift still plans unattended. Dev is unwrapped.
//
//   node --test infra/terraform/modules/bootstrap/tests/
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluate } from '@marcbachmann/cel-js';
import { claims, expression, repository } from './claims.mjs';

const wrapped = (inner) =>
  expression('production_approval.cel.tftpl').replace(
    '${gate}',
    expression(inner),
  );

const inProduction = (c) => ({
  ...c,
  environment: 'production',
  sub: `repo:${repository}:environment:production`,
});

for (const inner of ['deploy_gate.cel.tftpl', 'bunny_gate.cel.tftpl']) {
  const gate = (assertion) => evaluate(wrapped(inner), { assertion });

  test(`${inner}: still fits the 2048-character limit`, () => {
    assert.ok(wrapped(inner).length < 2048);
  });

  test(`${inner}: tofu-apply.yml outside the production environment is denied`, () => {
    for (const event_name of ['push', 'workflow_dispatch', 'workflow_run']) {
      assert.equal(gate(claims({ event_name })), 'denied', event_name);
      assert.equal(
        gate({ ...claims({ event_name }), environment: 'dev' }),
        'denied',
        `${event_name} in dev`,
      );
    }
  });

  test(`${inner}: tofu-apply.yml in the production environment on main is allowed`, () => {
    assert.equal(
      gate(inProduction(claims({ event_name: 'workflow_run' }))),
      'allowed',
    );
  });

  test(`${inner}: the production environment doesn't widen the inner gate`, () => {
    assert.equal(
      gate(inProduction(claims({ ref: 'refs/heads/feature' }))),
      'denied',
    );
    assert.equal(
      gate(
        inProduction(
          claims({ event_name: 'pull_request', ref: 'refs/pull/1/merge' }),
        ),
      ),
      'denied',
    );
  });

  test(`${inner}: drift still plans unattended`, () => {
    assert.equal(
      gate(claims({ workflow: 'tofu-drift.yml', event_name: 'schedule' })),
      'allowed',
    );
  });
}
