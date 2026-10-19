import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Starts a throwaway SurrealDB container for the integration tests, unless SURREAL_TEST_URL
 * points at one already (then SURREAL_TEST_USER / SURREAL_TEST_PASS are its root login).
 *
 * The image is the one the cluster runs: read from the Kustomize image pin (tag + digest), so
 * these tests always exercise the deployed SurrealDB version. The root password is random per
 * run and never leaves this process tree.
 */
const KUSTOMIZATION = join(
  __dirname,
  '../../../../infra/k8s/surrealdb/base/kustomization.yaml',
);

export function pinnedSurrealImage(): string {
  const text = readFileSync(KUSTOMIZATION, 'utf8');
  const match = text.match(
    /- name: (surrealdb\/surrealdb)\s+newTag: (v[\w.-]+@sha256:[0-9a-f]{64})/,
  );
  if (!match) {
    throw new Error(`No digest-pinned surrealdb image in ${KUSTOMIZATION}`);
  }
  return `${match[1]}:${match[2]}`;
}

async function waitForHealth(baseUrl: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      throw new Error(
        `SurrealDB at ${baseUrl} not healthy after ${timeoutMs}ms`,
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

export default async function globalSetup(): Promise<void> {
  if (process.env['SURREAL_TEST_URL']) {
    await waitForHealth(process.env['SURREAL_TEST_URL'].replace(/^ws/, 'http'));
    return;
  }
  const image = pinnedSurrealImage();
  const password = randomBytes(24).toString('hex');
  const id = execFileSync(
    'docker',
    [
      'run',
      '--detach',
      '--rm',
      '--publish',
      '127.0.0.1::8000',
      '--env',
      'SURREAL_USER=root',
      '--env',
      `SURREAL_PASS=${password}`,
      image,
      'start',
      'memory',
    ],
    { encoding: 'utf8' },
  ).trim();
  (globalThis as Record<string, unknown>)['__SURREAL_CONTAINER__'] = id;
  const port = execFileSync('docker', ['port', id, '8000/tcp'], {
    encoding: 'utf8',
  })
    .trim()
    .split('\n')[0]
    .split(':')
    .pop();
  process.env['SURREAL_TEST_URL'] = `ws://127.0.0.1:${port}`;
  process.env['SURREAL_TEST_USER'] = 'root';
  process.env['SURREAL_TEST_PASS'] = password;
  process.env['SURREAL_TEST_IMAGE'] = image;
  await waitForHealth(`http://127.0.0.1:${port}`);
}
