/**
 * housekeeping: the nightly chores (src/app/chores.ts). A Cloud Run Job started by Cloud
 * Scheduler (modules/gcp/housekeeping.tf), or by a developer with
 * `gcloud run jobs execute housekeeping --region europe-west2 --wait`.
 *
 * Exit status: 0 every chore done; 1 a chore or a deletion failed (the next run tries again;
 * every chore is safe to re-run); 2 refused (bad settings).
 * Logs one JSON line per chore with counts and ids only, never personal data or a key.
 */
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { connectDatabase } from '@heisreal/database';
import { SecretsService } from '@heisreal/secrets';
import { Surreal } from 'surrealdb';
import { CHORES } from './app/chores';
import { CLERK_SECRET_KEY, ClerkBackendUsers } from './app/clerk';
import { housekeepingConfig, RefusedError } from './app/config';
import { BunnyStreamLibrary } from './app/stream';
import { runTasks } from './app/tasks';

const log = (entry: Record<string, unknown>) =>
  console.log(JSON.stringify({ job: 'housekeeping', ...entry }));

async function main(): Promise<number> {
  let config;
  try {
    config = housekeepingConfig();
  } catch (err) {
    if (err instanceof RefusedError) {
      log({ refused: err.message });
      return 2;
    }
    throw err;
  }

  const secrets = new SecretsService(
    new SecretManagerServiceClient(),
    config.project,
  );
  const key = (await secrets.get(config.stream.keySecret)).trim();
  if (key === '') throw new Error(`Secret ${config.stream.keySecret} is empty`);
  let clerk: ClerkBackendUsers | null = null;
  if (config.clerkKeySecret) {
    const clerkKey = (await secrets.get(config.clerkKeySecret)).trim();
    if (!CLERK_SECRET_KEY.test(clerkKey)) {
      throw new Error(
        `Secret ${config.clerkKeySecret} isn't a Clerk secret key`,
      );
    }
    clerk = new ClerkBackendUsers(clerkKey);
  }
  const db = await connectDatabase(new Surreal(), config.database, secrets);
  try {
    log({
      start: CHORES.map((c) => c.name),
      dryRun: config.dryRun,
      maxDeletions: config.maxDeletions,
      clerk: clerk !== null,
    });
    return await runTasks(
      CHORES,
      {
        db,
        stream: new BunnyStreamLibrary(config.stream.libraryId, key),
        clerk,
        dryRun: config.dryRun,
        maxDeletions: config.maxDeletions,
        now: new Date(),
      },
      log,
    );
  } finally {
    await db.close().catch(() => undefined);
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    log({ error: (err as Error).message });
    process.exit(1);
  },
);
