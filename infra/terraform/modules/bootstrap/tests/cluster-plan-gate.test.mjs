// The WIF attribute mapping that gates tf-cluster-planner (D42), evaluated with a CEL engine
// against GitHub OIDC claim fixtures: the plain `plan-cluster` job's claims are accepted, and
// each way of not being that job is rejected. Google evaluates the same template
// (ci_identity.tf). Claims: https://docs.github.com/en/actions/reference/security/oidc
//
//   node --test infra/terraform/modules/bootstrap/tests/
import { evaluate } from '@marcbachmann/cel-js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const repository = 'He-Is-Real/monorepo';
const expression = readFileSync(
  new URL('../cluster_plan_gate.cel.tftpl', import.meta.url),
  'utf8',
)
  .replaceAll('${repository}', repository)
  .trim();

// A plain (non-reusable) job's token on a pull request, as GitHub issues it once the
// environment's reviewer has approved the run.
const prJob = {
  sub: `repo:${repository}:environment:cluster-plan`,
  repository,
  repository_id: '1390930896',
  repository_owner: 'He-Is-Real',
  environment: 'cluster-plan',
  event_name: 'pull_request',
  ref: 'refs/pull/32/merge',
  ref_type: 'branch',
  workflow: 'Terraform plan',
  workflow_ref: `${repository}/.github/workflows/terraform-plan.yml@refs/pull/32/merge`,
  workflow_sha: '0123456789abcdef0123456789abcdef01234567',
  job_workflow_ref: `${repository}/.github/workflows/terraform-plan.yml@refs/pull/32/merge`,
  runner_environment: 'github-hosted',
};
const gate = (claims) => evaluate(expression, { assertion: claims });
const without = (claims, key) => {
  const { [key]: _, ...rest } = claims;
  return rest;
};

test('accepts the plan-cluster job on a pull request', () => {
  assert.equal(gate(prJob), 'allowed');
});

test('accepts it without job_workflow_ref (only workflow_ref is read)', () => {
  assert.equal(gate(without(prJob, 'job_workflow_ref')), 'allowed');
});

test('accepts it on a push to main', () => {
  assert.equal(
    gate({
      ...prJob,
      event_name: 'push',
      ref: 'refs/heads/main',
      workflow_ref: `${repository}/.github/workflows/terraform-plan.yml@refs/heads/main`,
    }),
    'allowed',
  );
});

const rejected = {
  'no environment (a job without `environment: cluster-plan`)': without(
    prJob,
    'environment',
  ),
  'another environment': { ...prJob, environment: 'dev' },
  'another repository (e.g. a fork)': {
    ...prJob,
    repository: 'someone/monorepo',
  },
  'another workflow file': {
    ...prJob,
    workflow_ref: `${repository}/.github/workflows/ci.yml@refs/pull/32/merge`,
  },
  'a workflow of the same name in another repository': {
    ...prJob,
    workflow_ref: `someone/monorepo/.github/workflows/terraform-plan.yml@refs/pull/32/merge`,
  },
  'a push to another branch': {
    ...prJob,
    event_name: 'push',
    ref: 'refs/heads/feature',
  },
  workflow_dispatch: {
    ...prJob,
    event_name: 'workflow_dispatch',
    ref: 'refs/heads/main',
  },
  pull_request_target: { ...prJob, event_name: 'pull_request_target' },
  schedule: { ...prJob, event_name: 'schedule', ref: 'refs/heads/main' },
};
for (const [name, claims] of Object.entries(rejected)) {
  test(`rejects ${name}`, () => {
    assert.equal(gate(claims), 'denied');
  });
}
