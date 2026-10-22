#!/usr/bin/env node
/**
 * Creates the surrealdb-migration ConfigMap the migrate Job reads, on a local cluster: the
 * local developer machine equivalent of what OpenTofu builds on GKE
 * (infra/terraform/modules/db-migration). Same files, same parameters:
 *
 *   - every *.surql in libs/database/schema and libs/database/schema/data (flattened), and the
 *     runner, libs/database/schema/migrate.py;
 *   - params.json: dpa_sha256 = { <id>: sha256 of libs/legal/dpa/<id>.md } for every file there,
 *     clerk_jwt_public_key = the PEM file given, or null. No identity_hash: locally, restart
 *     SurrealDB yourself after changing the init Secret (the identity-check sidecar still gates
 *     readiness on the credentials).
 *
 * It then deletes a finished surrealdb-migrate Job so that re-applying the overlay runs it again:
 *
 *   node infra/k8s/surrealdb/scripts/local-migration.mjs [--context kind-heisreal] [--clerk-public-key-file key.pem] [--seed-dev-story]
 *   kubectl apply -k infra/k8s/surrealdb/overlays/local
 *
 * Refuses any cluster but a local one: GKE gets its migration from OpenTofu.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    context: { type: 'string' },
    namespace: { type: 'string', default: 'database' },
    'clerk-public-key-file': { type: 'string' },
    'seed-dev-story': { type: 'boolean', default: false },
  },
});

const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const schemaDir = join(root, 'libs/database/schema');
const dpaDir = join(root, 'libs/legal/dpa');

function kubectl(kubectlArgs, input) {
  const context = args.context ? [`--context=${args.context}`] : [];
  return execFileSync('kubectl', [...context, ...kubectlArgs], {
    encoding: 'utf8',
    input,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'inherit'],
  });
}

const context = args.context ?? kubectl(['config', 'current-context']).trim();
if (!/^(kind-|k3d-|minikube|docker-desktop|rancher-desktop)/.test(context)) {
  console.error(
    `Refusing to run against "${context}": local clusters only (kind, k3d, minikube, ...).`,
  );
  process.exit(1);
}

const surql = (dir) =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.surql'))
    .map((f) => [f, readFileSync(join(dir, f), 'utf8')]);
const dpaSha256 = Object.fromEntries(
  readdirSync(dpaDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => [
      f.slice(0, -'.md'.length),
      createHash('sha256')
        .update(readFileSync(join(dpaDir, f)))
        .digest('hex'),
    ]),
);
const clerkKeyFile = args['clerk-public-key-file'];
const params = {
  clerk_jwt_public_key: clerkKeyFile
    ? readFileSync(clerkKeyFile, 'utf8')
    : null,
  dpa_sha256: dpaSha256,
  identity_hash: null,
  seed_dev_story: args['seed-dev-story'],
};
if (params.clerk_jwt_public_key?.includes('PRIVATE KEY')) {
  console.error('That is a private key: pass the PEM *public* key only.');
  process.exit(1);
}

const data = Object.fromEntries([
  ...surql(schemaDir),
  ...surql(join(schemaDir, 'data')),
  ['migrate.py', readFileSync(join(schemaDir, 'migrate.py'), 'utf8')],
  ['params.json', JSON.stringify(params)],
]);
kubectl(
  ['apply', '-f', '-'],
  JSON.stringify({
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: 'surrealdb-migration', namespace: args.namespace },
    data,
  }),
);
console.log(
  `configmap/surrealdb-migration applied (${Object.keys(data).length - 2} SurrealQL files; ` +
    `clerk access ${params.clerk_jwt_public_key ? 'on' : 'off'})`,
);
kubectl([
  '-n',
  args.namespace,
  'delete',
  'job',
  'surrealdb-migrate',
  '--ignore-not-found',
]);
console.log(
  'Now run: kubectl apply -k infra/k8s/surrealdb/overlays/local (it starts the migrate Job)',
);
