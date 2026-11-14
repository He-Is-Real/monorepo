/**
 * The media worker (M2 plan item 13; D78, D126, D129; media-worker-final.html): runs on Joel's
 * machine beside Dapr's sidecar, which pulls `media-jobs` for it. For each check job it asks
 * Bunny (read-only key) about the video and calls the result writer on Cloud Run with what it
 * found. For each render job it makes an audio story's picture video (render.ts) with a one-hour
 * upload pass from the writer (audio-picture-video.html, K1) and, asked for just before each
 * download, a 2-minute link to one copy of the story's sound (R3). It holds no Bunny key but the
 * library's read-only one. It never touches the database,
 * keeps a job's files only in memory ($XDG_RUNTIME_DIR) while the job runs and listens on
 * 127.0.0.1 only.
 *
 * Start it with tools/scripts/media-worker.sh (docs/media-runbook.md, "Media ready"), which starts
 * Dapr beside it. It signs in as the media-worker Google account with this machine's own
 * certificate (W1-A, identity/): nobody's gcloud login, no Google key file. The certificate is
 * renewed here every few hours.
 */
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { type Severity, writeLog } from '@heisreal/logging';
import { JsonLogger } from '@heisreal/logging/nest';
import { SecretsService } from '@heisreal/secrets';
import { Logger } from '@nestjs/common';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { BunnyStreamReader, checkAnswer } from './bunny';
import { workerIdentity } from './identity';
import { FfmpegRenderer, isPicture } from './render';
import { workerServer } from './server';
import { type LogEntry, RenderSlot } from './worker';
import { httpWriter } from './writer';

/** How long the read-only key is used before it is read again (a rotated key arrives). */
const KEY_MAX_AGE_MS = 5 * 60_000;
const LIBRARY = /^[0-9]{1,12}$/;
const NAME = /^[A-Za-z0-9_-]{1,255}$/;

function env(name: string, pattern?: RegExp): string {
  const value = process.env[name];
  if (!value || (pattern && !pattern.test(value))) {
    throw new Error(`${name} is missing or malformed`);
  }
  return value;
}

/** The email in a Google ID token (Google just gave it to us, so it isn't verified again). */
function tokenEmail(token: string): unknown {
  const payload = token.split('.')[1] ?? '';
  return (
    JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      email?: unknown;
    }
  ).email;
}

// libs/secrets' own Nest `Logger` lines in the same format.
Logger.overrideLogger(new JsonLogger());

/**
 * How serious a line is (Joel, 2026-11-14: severities in the worker's logs too): the worker
 * stopping, a crash, a failed job or certificate renewal are errors; a job that can't be read or
 * answered now (it goes back to the queue, or is dropped) is a warning; the rest is routine.
 */
function severityOf(entry: Record<string, unknown>): Severity {
  switch (entry['step']) {
    case 'stopped':
    case 'crashed':
    case 'failed':
    case 'identity_renewal_failed':
      return 'ERROR';
    case 'unreadable':
      return 'WARNING';
    case 'busy':
      return 'INFO';
  }
  return entry['delivery'] === 'RETRY' || entry['delivery'] === 'DROP'
    ? 'WARNING'
    : 'INFO';
}

/** One line in the shared JSON log format (libs/logging); its message is the step. */
const log = (entry: LogEntry | Record<string, unknown>) => {
  const fields = entry as Record<string, unknown>;
  writeLog(
    severityOf(fields),
    String(fields['step'] ?? 'media-worker'),
    fields,
  );
};

async function main() {
  const project = env('GCP_PROJECT', NAME);
  const account = env('MEDIA_WORKER_ACCOUNT');
  const writerUrl = new URL(env('RESULT_WRITER_URL'));
  if (writerUrl.protocol !== 'https:') {
    throw new Error('RESULT_WRITER_URL must be https');
  }
  const audience = writerUrl.origin;
  const library = env('BUNNY_STREAM_LIBRARY_ID', LIBRARY);
  const keySecret = env('BUNNY_STREAM_READONLY_KEY_SECRET', NAME);
  const workDir = env('MEDIA_WORKER_WORK_DIR');
  const defaultPicture = env('MEDIA_WORKER_DEFAULT_PICTURE');
  if (!isAbsolute(workDir) || !existsSync(workDir)) {
    throw new Error('MEDIA_WORKER_WORK_DIR must be an existing absolute path');
  }
  if (
    !isAbsolute(defaultPicture) ||
    !existsSync(defaultPicture) ||
    !isPicture(readFileSync(defaultPicture).subarray(0, 12), 'jpeg')
  ) {
    throw new Error(
      'MEDIA_WORKER_DEFAULT_PICTURE must be an existing absolute path to a JPEG',
    );
  }
  const port = Number(env('APP_PORT', /^[0-9]{2,5}$/));
  // Dapr's sidecar sends it with every call; the server refuses anything without it.
  const appApiToken = env('APP_API_TOKEN', /^[A-Za-z0-9_-]{32,}$/);

  // The machine's certificate (W1-A): the script points Application Default Credentials at
  // it, so every Google call below is made as media-worker; ID tokens come from identity/.
  const identity = await workerIdentity(log);
  const idToken = () => identity.idToken(audience);
  // Refuse to run as anyone else: the worker may do only what media-worker may.
  const email = tokenEmail(await idToken());
  if (email !== account) {
    throw new Error(
      `Signed in as ${typeof email === 'string' ? email : 'an unknown account'}, not ${account}`,
    );
  }

  const secrets = new SecretsService(new SecretManagerServiceClient(), project);
  const bunny = new BunnyStreamReader(library, () =>
    secrets.get(keySecret, 'latest', { maxAgeMs: KEY_MAX_AGE_MS }),
  );
  const renderer = new FfmpegRenderer({
    bunny,
    workDir,
    defaultPicture,
  });
  const server = workerServer(
    {
      check: (video) => checkAnswer(bunny, video),
      renderer,
      renderSlot: new RenderSlot(),
      writer: httpWriter(writerUrl.toString(), idToken),
      log,
    },
    appApiToken,
  );
  server.listen(port, '127.0.0.1', () =>
    log({ step: 'started', account, port }),
  );
  const stop = () => {
    identity.stop();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err: unknown) => {
  log({
    step: 'stopped',
    code: err instanceof Error ? err.message : 'error',
  });
  process.exit(1);
});
