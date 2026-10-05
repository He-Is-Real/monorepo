#!/usr/bin/env node
/**
 * Creates the Kubernetes Secrets that the SurrealDB manifests need, reading
 * the passwords from Google Cloud Secret Manager with your gcloud login.
 * This is the local developer machine equivalent of External Secrets Operator on GKE.
 *
 *   node infra/k8s/surrealdb/scripts/local-secrets.mjs --project <dev-project-id> [--context kind-kind]
 *
 * Requires: gcloud (logged in) and kubectl pointed at a local cluster. It
 * refuses any other cluster: GKE gets its Secrets from External Secrets Operator.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    project: { type: 'string' },
    context: { type: 'string' },
    namespace: { type: 'string', default: 'database' },
  },
});
if (!args.project) {
  console.error(
    'Usage: local-secrets.mjs --project <dev-project-id> [--context <kube-context>]',
  );
  process.exit(1);
}

// Service password placeholders in init.surql.tmpl -> Secret Manager secret ids.
const SERVICE_SECRETS = {
  api_read: 'surreal-api-read-password',
  api_write: 'surreal-api-write-password',
  api_admin: 'surreal-api-admin-password',
  workflow: 'surreal-workflow-password',
  backup: 'surreal-backup-password',
  migrator: 'surreal-migrator-password',
};

function access(secretId) {
  return execFileSync(
    'gcloud',
    [
      'secrets',
      'versions',
      'access',
      'latest',
      `--secret=${secretId}`,
      `--project=${args.project}`,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  );
}

function kubectl(kubectlArgs, input) {
  const context = args.context ? [`--context=${args.context}`] : [];
  return execFileSync('kubectl', [...context, ...kubectlArgs], {
    encoding: 'utf8',
    input,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'inherit'],
  });
}

/** Applies a Secret; values are sent on stdin, never on the command line. */
function applySecret(name, data) {
  const manifest = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name, namespace: args.namespace },
    type: 'Opaque',
    stringData: data,
  };
  kubectl(['apply', '-f', '-'], JSON.stringify(manifest));
  console.log(`secret/${name} applied`);
}

/** Same substitution External Secrets Operator performs: {{ .key | toJson }}. */
function render(template, values) {
  return template.replace(/\{\{\s*\.(\w+)\s*\|\s*toJson\s*\}\}/g, (_, key) => {
    if (!(key in values)) throw new Error(`No value for placeholder ${key}`);
    return JSON.stringify(values[key]);
  });
}

const context = args.context ?? kubectl(['config', 'current-context']).trim();
if (!/^(kind-|k3d-|minikube|docker-desktop|rancher-desktop)/.test(context)) {
  console.error(
    `Refusing to run against "${context}": local clusters only (kind, k3d, minikube, ...).`,
  );
  process.exit(1);
}

kubectl(
  ['apply', '-f', '-'],
  JSON.stringify({
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: { name: args.namespace },
  }),
);

const passwords = Object.fromEntries(
  Object.entries(SERVICE_SECRETS).map(([key, secretId]) => [
    key,
    access(secretId),
  ]),
);
const template = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../base/init.surql.tmpl'),
  'utf8',
);

applySecret('surrealdb-root', {
  SURREAL_USER: 'root',
  SURREAL_PASS: access('surreal-root-password'),
});
applySecret('surrealdb-backup', {
  SURREAL_USER: 'backup',
  SURREAL_PASS: passwords.backup,
});
applySecret('surrealdb-init', { 'init.surql': render(template, passwords) });
