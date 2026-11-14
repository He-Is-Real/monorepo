/**
 * dev-seed (D49): resets the dev database to the D47 dummy dataset. A Cloud Run Job, dev only
 * (modules/gcp/dev_seed.tf), started by the "Reset dev data" Action as ci-dev-seeder (D50) or by
 * a developer with `gcloud run jobs execute dev-seed --region europe-west2 --wait`.
 *
 * Exit status: 0 reset done; 1 failed (nothing changed: the reset is one transaction);
 * 2 refused (not dev, or the dataset has a problem).
 * Prints counts and reasons, never a password, in the shared JSON log format (libs/logging).
 */
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { writeLog } from '@heisreal/logging';
import { JsonLogger } from '@heisreal/logging/nest';
import { Logger } from '@nestjs/common';
import { SecretsService, withTimeout } from '@heisreal/secrets';
import { Surreal } from 'surrealdb';
import { seedConfig } from './app/config';
import { DATASET } from './app/dataset';
import type { BunnyMedia } from './app/media';
import { buildVars } from './app/plan';
import { reset } from './app/seed';
import bunnyMedia from './app/bunny-media.json';

const CONNECT_TIMEOUT_MS = 15_000;

// libs/secrets' own Nest `Logger` lines in the same format.
Logger.overrideLogger(new JsonLogger());

async function main(): Promise<number> {
  let config;
  let vars;
  try {
    config = seedConfig();
    vars = buildVars(DATASET, bunnyMedia as BunnyMedia);
  } catch (err) {
    writeLog('ERROR', `dev-seed refused: ${(err as Error).message}`);
    return 2;
  }

  const secrets = new SecretsService(
    new SecretManagerServiceClient(),
    config.project,
  );
  const password = await secrets.get(config.passwordSecret);
  const db = new Surreal();
  try {
    await withTimeout(
      db.connect(config.url, {
        namespace: config.namespace,
        database: config.database,
        authentication: {
          namespace: config.namespace,
          database: config.database,
          username: config.username,
          password,
        },
        reconnect: false,
      }),
      CONNECT_TIMEOUT_MS,
      `Connecting to ${config.url}`,
    );
    writeLog(
      'INFO',
      `dev-seed: resetting ${config.namespace}/${config.database} as ${config.username} ` +
        `(${vars.stories.length} stories, ${vars.people.length + 1} people, ${vars.themes.length} themes)`,
    );
    const summary = await reset(db, vars);
    writeLog('INFO', 'dev-seed: done', { summary });
    return 0;
  } catch (err) {
    writeLog(
      'ERROR',
      `dev-seed failed, nothing changed: ${(err as Error).message}`,
    );
    return 1;
  } finally {
    await db.close().catch(() => undefined);
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    writeLog('ERROR', `dev-seed failed: ${(err as Error).message}`);
    process.exit(1);
  },
);
