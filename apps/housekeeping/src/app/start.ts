import { connectDatabase } from '@heisreal/database';
import type { SecretsService } from '@heisreal/secrets';
import { Surreal } from 'surrealdb';
import { CHORES } from './chores';
import { CLERK_SECRET_KEY, ClerkBackendUsers, type ClerkUsers } from './clerk';
import type { HousekeepingConfig } from './config';
import { BunnyStreamLibrary, type StreamLibrary } from './stream';
import { type Log, runTasks, type Task } from './tasks';

/** What startHousekeeping uses from outside; tests replace Bunny and Clerk. */
export interface Startup {
  config: HousekeepingConfig;
  secrets: SecretsService;
  log: Log;
  chores?: readonly Task[];
  stream?: (libraryId: string, key: string) => StreamLibrary;
  clerk?: (key: string) => ClerkUsers;
}

/**
 * Reads the keys, connects as service:housekeeping and runs the chores. Answers the exit status
 * (main.ts). Clerk's key is only needed for queued Clerk deletions, so a Clerk key that can't be
 * read (no enabled version, no access, not a Clerk key) is logged as an error and those deletions
 * wait; every other chore still runs, and the run answers 1 so it shows as failed.
 */
export async function startHousekeeping({
  config,
  secrets,
  log,
  chores = CHORES,
  stream = (libraryId, key) => new BunnyStreamLibrary(libraryId, key),
  clerk: clerkUsers = (key) => new ClerkBackendUsers(key),
}: Startup): Promise<number> {
  const key = (await secrets.get(config.stream.keySecret)).trim();
  if (key === '') throw new Error(`Secret ${config.stream.keySecret} is empty`);
  let clerk: ClerkUsers | null = null;
  let clerkFailed = false;
  if (config.clerkKeySecret) {
    try {
      const clerkKey = (await secrets.get(config.clerkKeySecret)).trim();
      if (!CLERK_SECRET_KEY.test(clerkKey)) {
        throw new Error(
          `Secret ${config.clerkKeySecret} isn't a Clerk secret key`,
        );
      }
      clerk = clerkUsers(clerkKey);
    } catch (err) {
      clerkFailed = true;
      // Cloud Logging reads `severity` from a JSON line: this one shows as an error.
      log({
        severity: 'ERROR',
        error: `Clerk's key (secret ${config.clerkKeySecret}) can't be used, so Clerk deletions wait: ${(err as Error).message}`,
      });
    }
  }
  const db = await connectDatabase(new Surreal(), config.database, secrets);
  try {
    log({
      start: chores.map((c) => c.name),
      dryRun: config.dryRun,
      maxDeletions: config.maxDeletions,
      clerk: clerk !== null,
    });
    const code = await runTasks(
      chores,
      {
        db,
        stream: stream(config.stream.libraryId, key),
        clerk,
        dryRun: config.dryRun,
        maxDeletions: config.maxDeletions,
        now: new Date(),
      },
      log,
    );
    return clerkFailed ? 1 : code;
  } finally {
    await db.close().catch(() => undefined);
  }
}
