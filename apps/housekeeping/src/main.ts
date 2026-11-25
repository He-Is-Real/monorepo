/**
 * housekeeping: the nightly chores (src/app/chores.ts). A Cloud Run Job started by Cloud
 * Scheduler (modules/gcp/housekeeping.tf): at 03:30 London time the nightly chores, and at 18:00
 * with HOUSEKEEPING_CHORES=media-resend only the media resend. Or by a developer with
 * `gcloud run jobs execute housekeeping --region europe-west2 --wait` (add
 * `--update-env-vars HOUSEKEEPING_CHORES=media-resend` for the resend).
 *
 * Exit status: 0 every chore done; 1 a chore or a deletion failed, or Clerk's key couldn't be read
 * (the next run tries again; every chore is safe to re-run); 2 refused (bad settings); 143 stopped
 * by SIGTERM (the job was cancelled or timed out; queued log lines are sent first, at most 3 s).
 * Logs one line per chore in the shared JSON log format (libs/logging) with counts and ids only,
 * never personal data or a key.
 */
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { flushLogSinks, type Severity, writeLog } from '@heisreal/logging';
import { startAxiomLogs } from '@heisreal/logging/axiom';
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

  const secrets = new SecretsService(
    new SecretManagerServiceClient(),
    config.project,
  );
  // Every line also goes to Axiom where OpenTofu set it up (LG-3); never stops the job.
  await startAxiomLogs({ read: (name) => secrets.get(name) });
  return startHousekeeping({ config, secrets, log });
}

/** Sends what Axiom still waits for (at most 3 s), then exits; only the first call counts. */
let exiting = false;
const exit = (code: number) => {
  if (exiting) return;
  exiting = true;
  void flushLogSinks(3000).then(() => process.exit(code));
};

// Cloud Run cancelled the job or it ran out of time: keep the logs, exit as a cancelled job.
process.on('SIGTERM', () => exit(143));

main().then(exit, (err) => {
  log({
    severity: 'ERROR',
    message: 'housekeeping failed',
    error: (err as Error).message,
  });
  exit(1);
});
