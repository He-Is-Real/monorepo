/**
 * housekeeping: the nightly chores (src/app/chores.ts). A Cloud Run Job started by Cloud
 * Scheduler (modules/gcp/housekeeping.tf), or by a developer with
 * `gcloud run jobs execute housekeeping --region europe-west2 --wait`.
 *
 * Exit status: 0 every chore done; 1 a chore or a deletion failed, or Clerk's key couldn't be read
 * (the next run tries again; every chore is safe to re-run); 2 refused (bad settings).
 * Logs one JSON line per chore with counts and ids only, never personal data or a key.
 */
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { SecretsService } from '@heisreal/secrets';
import { housekeepingConfig, RefusedError } from './app/config';
import { startHousekeeping } from './app/start';

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

  return startHousekeeping({
    config,
    secrets: new SecretsService(
      new SecretManagerServiceClient(),
      config.project,
    ),
    log,
  });
}

main().then(
  (code) => process.exit(code),
  (err) => {
    log({ severity: 'ERROR', error: (err as Error).message });
    process.exit(1);
  },
);
