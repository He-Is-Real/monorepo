/**
 * Renewal (W1-A; Joel, 2026-11-08: a new key and certificate every 6 hours, each valid 24 hours,
 * both settings): make a new key, ask the signing service for a certificate for it (proving the
 * current one with the current key), check what came back, swap it in, delete the old key.
 * A copied certificate dies within its lifetime; the key it belongs to is gone the moment the
 * new pair is renamed over it.
 *
 * The new key is saved (keys/pending.pem) before it is sent, and every retry sends that same key
 * until its certificate is installed: if the signing service issued one but the reply was lost,
 * the retry gets that same certificate back (W3-1 A; Joel, 2026-11-09).
 */
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  X509Certificate,
} from 'node:crypto';
import { renewalRequest, type RenewalRequest } from '@heisreal/worker-identity';
import type { IdentityStore } from './store';

/** Sends a renewal to the signing service and returns the new certificate (PEM). */
export type RequestCertificate = (request: RenewalRequest) => Promise<string>;

const FIRST_RETRY_MS = 60_000;
const MAX_RETRY_MS = 30 * 60_000;
/** A retry close to expiry still waits this long, so a refusing service isn't hammered. */
const MIN_RETRY_MS = 10_000;
/** Node's timers take at most 2^31-1 ms (about 24.8 days); longer ones fire at once. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

const spki = (key: KeyObject) =>
  key.export({ type: 'spki', format: 'der' }) as Buffer;

/**
 * The key to ask a certificate for: the saved pending one, or a new one saved first. A pending
 * key that is already the current certificate's (stopped between installing and tidying up) or
 * can't be read is replaced.
 */
async function nextKey(
  store: IdentityStore,
  currentCert: X509Certificate,
): Promise<{ privateKey: KeyObject; publicKey: KeyObject }> {
  const saved = await store.pending();
  let reuse: { privateKey: KeyObject; publicKey: KeyObject } | null = null;
  if (saved !== null) {
    try {
      const privateKey = createPrivateKey(saved);
      const publicKey = createPublicKey(privateKey);
      if (!spki(publicKey).equals(spki(currentCert.publicKey))) {
        reuse = { privateKey, publicKey };
      }
    } catch {
      // Unreadable: a new one below.
    }
  }
  if (reuse) {
    // An earlier try may have stopped before its save was durable: make sure, every time, before
    // the key is sent (a failure here stops this try, as it would for a new key).
    await store.syncPending();
    return reuse;
  }
  const next = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  await store.savePending(
    next.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
  );
  return next;
}

/** Renews once. Returns the new certificate's expiry. */
export async function renewOnce(
  store: IdentityStore,
  requestCertificate: RequestCertificate,
): Promise<{ notAfter: Date }> {
  const current = await store.current();
  const currentCert = new X509Certificate(current.certificate);
  const next = await nextKey(store, currentCert);
  const pem = await requestCertificate(
    renewalRequest(
      current.certificate,
      createPrivateKey(current.key),
      next.publicKey,
    ),
  );
  // Use it only if it is what we asked for: our authority, our name, our new key.
  const cert = new X509Certificate(pem);
  const ca = new X509Certificate(await store.ca());
  const sameKey = spki(cert.publicKey).equals(spki(next.publicKey));
  if (
    !cert.verify(ca.publicKey) ||
    cert.subject !== currentCert.subject ||
    !sameKey
  ) {
    throw new Error(
      'the signing service returned a certificate we did not ask for',
    );
  }
  await store.install(
    next.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    pem,
  );
  return { notAfter: cert.validToDate };
}

/**
 * When the next renewal is due: `intervalMs` after the certificate was issued (so a restart
 * doesn't push it back), but never later than the last quarter of its lifetime, so a lifetime
 * shorter than the interval still renews in time with room for retries.
 */
export function renewalDue(
  cert: { validFrom: number; validTo: number },
  intervalMs: number,
): number {
  const lifetime = cert.validTo - cert.validFrom;
  return Math.min(cert.validFrom + intervalMs, cert.validTo - lifetime / 4);
}

/** The wait before a retry: the backoff, but halfway to expiry if that comes sooner. */
export function retryWait(
  backoffMs: number,
  validTo: number | undefined,
  now: number,
): number {
  if (validTo === undefined || validTo <= now) return backoffMs;
  return Math.min(backoffMs, Math.max(MIN_RETRY_MS, (validTo - now) / 2));
}

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms).unref(),
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/**
 * Renews when due (renewalDue). On failure: one log line, then again after 1, 2, 4 … up to 30
 * minutes, sooner if the certificate would expire first (retryWait). Never logs a key or
 * certificate. Refuses an interval Node's timers can't hold (MAX_TIMER_MS).
 */
export function startRenewal(options: {
  store: IdentityStore;
  requestCertificate: RequestCertificate;
  intervalMs: number;
  log: (entry: Record<string, unknown>) => void;
  timers?: Timers;
  now?: () => number;
}): () => void {
  const { store, requestCertificate, intervalMs, log } = options;
  if (!(intervalMs > 0 && intervalMs <= MAX_TIMER_MS)) {
    throw new Error(
      `the renewal interval must be between 0 and ${MAX_TIMER_MS} ms (about 24.8 days)`,
    );
  }
  const timers = options.timers ?? realTimers;
  const now = options.now ?? Date.now;
  let handle: unknown;
  let stopped = false;
  let retryMs = FIRST_RETRY_MS;

  const schedule = (ms: number, fn: () => Promise<void>) => {
    if (!stopped)
      handle = timers.set(
        () => void fn(),
        Math.min(MAX_TIMER_MS, Math.max(0, ms)),
      );
  };
  const currentValidity = async () => {
    try {
      const cert = new X509Certificate((await store.current()).certificate);
      return {
        validFrom: cert.validFromDate.getTime(),
        validTo: cert.validToDate.getTime(),
      };
    } catch {
      return undefined;
    }
  };

  const renew = async (): Promise<void> => {
    try {
      const { notAfter } = await renewOnce(store, requestCertificate);
      // An older layout's separate files, now that nothing names them.
      await store.remove(await store.unused()).catch(() => undefined);
      retryMs = FIRST_RETRY_MS;
      log({ step: 'identity_renewed', notAfter: notAfter.toISOString() });
      const validity = await currentValidity();
      schedule(validity ? renewalDue(validity, intervalMs) - now() : 0, renew);
    } catch (err) {
      const validTo = (await currentValidity())?.validTo;
      const wait = retryWait(retryMs, validTo, now());
      log({
        step: 'identity_renewal_failed',
        code: err instanceof Error ? err.message : 'error',
        // No readable certificate: say so through expiresAt only.
        expiresAt:
          validTo === undefined ? 'unknown' : new Date(validTo).toISOString(),
        retryInSeconds: Math.round(wait / 1000),
      });
      schedule(wait, renew);
      retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
    }
  };

  void (async () => {
    // Anything left from before a crash, then the first renewal when it is due.
    await store.remove(await store.unused()).catch(() => undefined);
    const validity = await currentValidity();
    schedule(validity ? renewalDue(validity, intervalMs) - now() : 0, renew);
  })();

  return () => {
    stopped = true;
    timers.clear(handle);
  };
}

/** The signing service over HTTPS, as media-worker (Cloud Run checks the ID token). */
export function httpRequestCertificate(
  signerUrl: string,
  idToken: () => Promise<string>,
  fetcher: typeof fetch = fetch,
): RequestCertificate {
  const url = `${signerUrl.replace(/\/+$/, '')}/v1/certificates`;
  return async (request) => {
    const res = await fetcher(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await idToken()}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(request),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 403) {
      // The service doesn't say why (its log does): expired, cancelled, or not the newest.
      throw new Error(
        "the signing service refused this machine's certificate (403): if the name wasn't cancelled, another copy of it may have renewed first; cancel the name and enrol a new one (docs/media-runbook.md, Worker identity)",
      );
    }
    if (!res.ok) throw new Error(`the signing service answered ${res.status}`);
    const body = (await res.json()) as { certificate?: unknown };
    if (typeof body.certificate !== 'string') {
      throw new Error('the signing service answered without a certificate');
    }
    return body.certificate;
  };
}
