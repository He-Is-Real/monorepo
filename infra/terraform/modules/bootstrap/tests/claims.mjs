// Shared fixtures for the WIF gate tests: GitHub OIDC claims and a CEL evaluator for the gate
// templates. Google evaluates the same templates (ci_identity.tf).
// Claims: https://docs.github.com/en/actions/reference/security/oidc
import { evaluate } from '@marcbachmann/cel-js';
import { readFileSync } from 'node:fs';

export const repository = 'He-Is-Real/monorepo';

const workflowRef = (file, ref) =>
  `${repository}/.github/workflows/${file}@${ref}`;

// A plain (non-reusable) job's token. `workflow` sets workflow_ref and job_workflow_ref
// together (they're equal for a plain job), on `ref`.
export const claims = ({ workflow = 'tofu-apply.yml', ...overrides } = {}) => {
  const ref = overrides.ref ?? 'refs/heads/main';
  return {
    sub: `repo:${repository}:ref:${ref}`,
    repository,
    repository_id: '1390930896',
    repository_owner: 'He-Is-Real',
    event_name: 'push',
    ref,
    ref_type: 'branch',
    workflow_ref: workflowRef(workflow, ref),
    job_workflow_ref: workflowRef(workflow, ref),
    workflow_sha: '0123456789abcdef0123456789abcdef01234567',
    runner_environment: 'github-hosted',
    ...overrides,
  };
};

export const without = (object, key) => {
  const { [key]: _, ...rest } = object;
  return rest;
};

// Evaluates a gate template (file name in the module directory) against the claims.
export const gate = (templateFile, assertion) =>
  evaluate(expression(templateFile), { assertion });

export const expression = (templateFile) =>
  readFileSync(new URL(`../${templateFile}`, import.meta.url), 'utf8')
    .replaceAll('${repository}', repository)
    .trim();
