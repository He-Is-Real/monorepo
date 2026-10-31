import { connectDatabase } from '@heisreal/database';
import type { SecretsService } from '@heisreal/secrets';
import { Surreal } from 'surrealdb';
import { CHORES } from './chores';
import { CLERK_SECRET_KEY, ClerkBackendUsers, type ClerkUsers } from './clerk';
import type { HousekeepingConfig } from './config';
import { BunnyImageZone, type ImageZone } from './images';
import { BunnyStreamLibrary, type StreamLibrary } from './stream';
import { type Log, runTasks, type Task } from './tasks';

/** What startHousekeeping uses from outside; tests replace Bunny, Clerk and the images zone. */
export interface Startup {
  config: HousekeepingConfig;
  secrets: SecretsService;
  log: Log;
  chores?: readonly Task[];
  stream?: (libraryId: string, key: string) => StreamLibrary;
  clerk?: (key: string) => ClerkUsers;
  images?: (zone: {
    name: string;
    host: string;
    password: string;
  }) => ImageZone;
}

/**
 * Reads the keys, connects as service:housekeeping and runs the chores. Answers the exit status
 * (main.ts). Bunny's key is only needed for video deletions, Clerk's for Clerk deletions and the
 * images zone's password for picture deletions, so a key that can't be used (no enabled version, no access, empty, not a Clerk key) is logged as an
 * error and that work waits; every other chore (erasure requests above all) still runs, and the
 * run answers 1 so it shows as failed.
 */
export async function startHousekeeping({
  config,
  secrets,
  log,
  chores = CHORES,
  stream = (libraryId, key) => new BunnyStreamLibrary(libraryId, key),
  clerk: clerkUsers = (key) => new ClerkBackendUsers(key),
  images: imageZone = (zone) => new BunnyImageZone(zone),
}: Startup): Promise<number> {
  let library: StreamLibrary | null = null;
  let keyFailed = false;
  try {
    const key = (await secrets.get(config.stream.keySecret)).trim();
    if (key === '')
      throw new Error(`Secret ${config.stream.keySecret} is empty`);
    library = stream(config.stream.libraryId, key);
  } catch (err) {
    keyFailed = true;
    // Cloud Logging reads `severity` from a JSON line: this one shows as an error.
    log({
      severity: 'ERROR',
      error: `Bunny Stream's key (secret ${config.stream.keySecret}) can't be used, so video deletions wait: ${(err as Error).message}`,
    });
  }
  let clerk: ClerkUsers | null = null;
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
      keyFailed = true;
      // Cloud Logging reads `severity` from a JSON line: this one shows as an error.
      log({
        severity: 'ERROR',
        error: `Clerk's key (secret ${config.clerkKeySecret}) can't be used, so Clerk deletions wait: ${(err as Error).message}`,
      });
    }
  }
  let images: ImageZone | null = null;
  if (config.images) {
    const { zone, s3Host, passwordSecret } = config.images;
    try {
      const password = (await secrets.get(passwordSecret)).trim();
      if (password === '') throw new Error(`Secret ${passwordSecret} is empty`);
      images = imageZone({ name: zone, host: s3Host, password });
    } catch (err) {
      keyFailed = true;
      // Cloud Logging reads `severity` from a JSON line: this one shows as an error.
      log({
        severity: 'ERROR',
        error: `The images zone's password (secret ${passwordSecret}) can't be used, so picture deletions wait: ${(err as Error).message}`,
      });
    }
  }
  const db = await connectDatabase(new Surreal(), config.database, secrets);
  try {
    log({
      start: chores.map((c) => c.name),
      dryRun: config.dryRun,
      maxDeletions: config.maxDeletions,
      stream: library !== null,
      clerk: clerk !== null,
      images: images !== null,
    });
    const code = await runTasks(
      chores,
      {
        db,
        stream: library,
        clerk,
        images,
        dryRun: config.dryRun,
        maxDeletions: config.maxDeletions,
        now: new Date(),
      },
      log,
    );
    return keyFailed ? 1 : code;
  } finally {
    await db.close().catch(() => undefined);
  }
}
