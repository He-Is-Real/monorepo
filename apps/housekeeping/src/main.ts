/**
 * housekeeping: the nightly chores (src/app/chores.ts). A Cloud Run Job started by Cloud
 * Scheduler (modules/gcp/housekeeping.tf): at 03:30 London time the nightly chores, and at 18:00
 * with HOUSEKEEPING_CHORES=media-resend only the media resend. Or by a developer with
 * `gcloud run jobs execute housekeeping --region europe-west2 --wait` (add
 * `--update-env-vars HOUSEKEEPING_CHORES=media-resend` for the resend).
 *
 * Exit status: 0 every chore done; 1 a chore or a deletion failed, or Clerk's key couldn't be read
 * (the next run tries again; every chore is safe to re-run); 2 refused (bad settings).
 * Logs one line per chore in the shared JSON log format (libs/logging) with counts and ids only,
 * never personal data or a key.
 */
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { type Severity, writeLog } from '@heisreal/logging';
import { JsonLogger } from '@heisreal/logging/nest';
import { Logger } from '@nestjs/common';
import { SecretsService } from '@heisreal/secrets';
import { housekeepingConfig, RefusedError } from './app/config';
import { startHousekeeping } from './app/start';

// The libraries' own Nest `Logger` lines (secrets, database) in the same format.
Logger.overrideLogger(new JsonLogger());

const log = ({ severity, message, ...entry }: Record<string, unknown>) =>
  writeLog(
    (severity as Severity | undefined) ?? 'INFO',
    typeof message === 'string' ? message : 'housekeeping',
    { job: 'housekeeping', ...entry },
  );

async function main(): Promise<number> {
  let config;
  try {
    config = housekeepingConfig();
  } catch (err) {
    if (err instanceof RefusedError) {
      log({
        severity: 'ERROR',
        message: 'housekeeping refused its settings',
        refused: err.message,
      });
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
    log({
      severity: 'ERROR',
      message: 'housekeeping failed',
      error: (err as Error).message,
    });
    process.exit(1);
  },
);
