/**
 * The media worker's own Google identity (W1-A; Joel, 2026-11-08): a certificate from our
 * authority instead of anyone's gcloud login. Set up once per machine with
 * `tools/scripts/worker-identity.sh enrol <machine>`; from then on the worker renews it itself.
 */
import { readFile } from 'node:fs/promises';
import { idTokens } from './google';
import { httpRequestCertificate, MAX_TIMER_MS, startRenewal } from './renewal';
import { defaultIdentityDir, IdentityStore } from './store';

/** Default: a new key and certificate every 6 hours (Joel, 2026-11-08, W1-A). */
const DEFAULT_RENEW_HOURS = 6;

export async function workerIdentity(
  log: (entry: Record<string, unknown>) => void,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{
  serviceAccount: string;
  idToken: (audience: string) => Promise<string>;
  stop: () => void;
}> {
  const store = new IdentityStore(defaultIdentityDir(env));
  const info = await store.info();
  const credentials = JSON.parse(
    await readFile(store.credentialsPath, 'utf8'),
  ) as Record<string, unknown>;
  const idToken = idTokens(credentials, info.serviceAccount);
  const hours = Number(env['IDENTITY_RENEW_HOURS'] ?? DEFAULT_RENEW_HOURS);
  // Node's timers hold at most about 24.8 days (MAX_TIMER_MS); refuse more at start-up.
  if (!(hours > 0 && hours * 3600_000 <= MAX_TIMER_MS)) {
    throw new Error(
      `IDENTITY_RENEW_HOURS must be more than 0 and at most ${Math.floor(MAX_TIMER_MS / 3600_000)}`,
    );
  }
  const signer = new URL(info.signerUrl);
  if (signer.protocol !== 'https:')
    throw new Error('the signing service must be https');
  const stop = startRenewal({
    store,
    requestCertificate: httpRequestCertificate(info.signerUrl, () =>
      idToken(signer.origin),
    ),
    intervalMs: hours * 3600_000,
    log,
  });
  return { serviceAccount: info.serviceAccount, idToken, stop };
}
