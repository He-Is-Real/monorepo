import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import {
  pinnedSurrealImage,
  type SavedTestDatabase,
  type SurrealTestLogin,
} from '@heisreal/database/integration-testing';

/**
 * The scale test's SurrealDB (LOCAL ONLY): the cluster's image on RocksDB, its data on a named
 * Docker volume kept between runs, so the 50,000 stories are loaded once (about 20 minutes)
 * and reused. The volume's name carries a hash of what the data depends on: the schema files,
 * the dataset generator (dataset.ts), the image and SCALE_STORIES (also in the name). Change any of them and the
 * next run loads afresh (and removes the older scale volumes of that size).
 *
 * The root password and the database's logins (test credentials only) are kept in
 * ~/.cache/heisreal-scale/<volume>.json.
 *
 * SCALE_FRESH=1 forces a fresh load. SCALE_KEEP=1 leaves the container running afterwards (for
 * EXPLAIN by hand). Free the disk: `docker volume ls -q -f name=heisreal-scale | xargs docker volume rm`.
 */
export interface ScaleState {
  rootPassword: string;
  /** TestDatabase.saved() once the dataset is fully loaded. */
  db?: SavedTestDatabase;
  /** A namespace whose load didn't finish (removed before the next load). */
  loading?: string;
}

declare module 'vitest' {
  export interface ProvidedContext {
    scaleStateFile: string;
  }
}

// The schema's files, which the data depends on (read only to hash them).
const SCHEMA = join(__dirname, '../../../libs/database/schema');
const CACHE = join(homedir(), '.cache', 'heisreal-scale');
const docker = (...args: string[]) =>
  execFileSync('docker', args, { encoding: 'utf8' }).trim();

/** What the loaded data depends on. */
export function scaleKey(stories: string): string {
  const hash = createHash('sha256');
  for (const f of readdirSync(SCHEMA).sort()) {
    if (f.endsWith('.surql') || f.endsWith('.py'))
      hash.update(f).update(readFileSync(join(SCHEMA, f)));
  }
  const data = join(SCHEMA, 'data');
  if (existsSync(data))
    for (const f of readdirSync(data).sort())
      hash.update(f).update(readFileSync(join(data, f)));
  hash.update(readFileSync(join(__dirname, 'dataset.ts')));
  hash.update(pinnedSurrealImage()).update(stories);
  return hash.digest('hex').slice(0, 12);
}

async function waitForHealth(baseUrl: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline)
      throw new Error(`SurrealDB at ${baseUrl} not healthy`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

export default async function globalSetup(project: TestProject) {
  const stories = process.env['SCALE_STORIES'] ?? '50000';
  const name = `heisreal-scale-${stories}-${scaleKey(stories)}`;
  const stateFile = join(CACHE, `${name}.json`);
  mkdirSync(CACHE, { recursive: true, mode: 0o700 });
  docker('rm', '--force', name);
  if (process.env['SCALE_FRESH'] === '1') {
    if (docker('volume', 'ls', '-q', '-f', `name=^${name}$`))
      docker('volume', 'rm', name);
    rmSync(stateFile, { force: true });
  }
  if (!existsSync(stateFile)) {
    // A new dataset: the older scale volumes of this size and their logins go.
    for (const old of docker(
      'volume',
      'ls',
      '-q',
      '-f',
      `name=heisreal-scale-${stories}-`,
    )
      .split('\n')
      .filter((v) => v && v !== name)) {
      docker('volume', 'rm', '--force', old);
      rmSync(join(CACHE, `${old}.json`), { force: true });
    }
    if (docker('volume', 'ls', '-q', '-f', `name=^${name}$`))
      docker('volume', 'rm', name);
    const state: ScaleState = {
      rootPassword: randomBytes(24).toString('hex'),
    };
    writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });
  }
  const state = JSON.parse(readFileSync(stateFile, 'utf8')) as ScaleState;
  // root: a fresh named volume belongs to root, and the image runs as nonroot.
  docker(
    'run',
    '--detach',
    '--rm',
    '--name',
    name,
    '--user',
    'root',
    '--volume',
    `${name}:/data`,
    '--publish',
    '127.0.0.1::8000',
    '--env',
    'SURREAL_USER=root',
    '--env',
    `SURREAL_PASS=${state.rootPassword}`,
    pinnedSurrealImage(),
    'start',
    'rocksdb:/data/surrealdb',
  );
  const port = docker('port', name, '8000/tcp').split('\n')[0].split(':').pop();
  await waitForHealth(`http://127.0.0.1:${port}`);
  project.provide('surrealTest', {
    url: `ws://127.0.0.1:${port}`,
    user: 'root',
    pass: state.rootPassword,
  } satisfies SurrealTestLogin);
  project.provide('scaleStateFile', stateFile);
  return () => {
    if (process.env['SCALE_KEEP'] !== '1') docker('stop', name);
  };
}
