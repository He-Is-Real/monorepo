/**
 * "Newest only" (W2-1 A; Joel, 2026-11-09, worker-and-gcloud-sign-in.html): the signing service
 * renews a machine's certificate only if it is the newest one issued for that machine. The newest
 * one's serial and expiry (and, below, the certificate itself) are one small JSON object per machine in a private London Cloud Storage
 * bucket (infra/terraform/modules/gcp/worker_identity.tf); not a database. A copied certificate
 * and key can't keep a second line of renewals going: whichever copy renews first makes the other
 * one stale, and its next renewal is refused.
 *
 * Writes carry the generation that was read (ifGenerationMatch), so two renewals of the same
 * certificate can't both win.
 *
 * A lost reply (W3-1 A; Joel, 2026-11-09): the record also holds the newest certificate itself
 * (public), the SHA-256 of the key it was issued for, and the serial of the certificate it
 * replaced. A worker whose reply was lost still holds that previous certificate and asks again
 * with the same new key (it saved the key first); it gets the recorded certificate back,
 * unchanged (replayFor). Nothing is signed and the record stays as it is, so a replay can't
 * extend a lifetime or start a second line of renewals; any other key is still refused. Plain REST, like kms.ts: the caller passes its own access token
 * (cert-signer's account on Cloud Run; a developer's gcloud login for enrol).
 */
import { createHash, type KeyObject, X509Certificate } from 'node:crypto';
import { MACHINE_NAME } from './certificates';

/** The newest certificate issued for a machine. */
export interface NewestCertificate {
  /** Upper-case hex, as X509Certificate.serialNumber gives it. */
  serial: string;
  /** ISO 8601. */
  notAfter: string;
  /**
   * SHA-256 (lower-case hex) of the public key (SPKI DER) the certificate was issued for, and the
   * certificate itself (PEM). Absent in a record written before W3-1: no replay then.
   */
  keySha256?: string;
  certificate?: string;
  /** The serial of the certificate this one replaced by renewal; absent after an enrol. */
  previousSerial?: string;
}

export interface NewestRecord extends NewestCertificate {
  /** Cloud Storage's object generation: what a conditional write must still find. */
  generation: string;
}

export interface NewestRecords {
  /** The machine's record, or null if it has none (never enrolled, or enrolled before W2-1). */
  read(machine: string): Promise<NewestRecord | null>;
  /**
   * Writes the machine's record. With `ifGeneration`, only if the record is still that
   * generation; returns false if someone else wrote first. Without it, unconditionally (enrol).
   */
  write(
    machine: string,
    newest: NewestCertificate,
    ifGeneration?: string,
  ): Promise<boolean>;
}

export const BUCKET_NAME = /^[a-z0-9][a-z0-9_-]{1,61}[a-z0-9]$/;

const STORAGE = 'https://storage.googleapis.com';
const TIMEOUT_MS = 15_000;
const SERIAL = /^[0-9A-F]{2,40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const PEM_CERTIFICATE =
  /^-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]+-----END CERTIFICATE-----\n?$/;

const serialOf = (cert: X509Certificate) => cert.serialNumber.toUpperCase();

export const keySha256 = (key: KeyObject): string =>
  createHash('sha256')
    .update(key.export({ type: 'spki', format: 'der' }))
    .digest('hex');

/** The record for `cert`; `replaced` is the certificate a renewal replaced (none for enrol). */
export function newestOf(
  cert: X509Certificate,
  replaced?: X509Certificate,
): NewestCertificate {
  return {
    serial: serialOf(cert),
    notAfter: cert.validToDate.toISOString(),
    keySha256: keySha256(cert.publicKey),
    certificate: cert.toString(),
    ...(replaced ? { previousSerial: serialOf(replaced) } : {}),
  };
}

/** Is `cert` the machine's newest certificate? */
export function isNewest(
  cert: X509Certificate,
  record: NewestCertificate | null,
): boolean {
  return record !== null && record.serial === serialOf(cert);
}

/**
 * The recorded newest certificate, if this request is a retry of the renewal that made it: the
 * caller proved `current`, the certificate that renewal replaced, and asks for the same key the
 * newest one was issued for (W3-1 A). Otherwise null (refuse as "not the newest").
 */
export function replayFor(
  record: NewestCertificate | null,
  current: X509Certificate,
  publicKey: KeyObject,
): { certificate: string; notAfter: Date } | null {
  if (
    !record?.certificate ||
    record.previousSerial !== serialOf(current) ||
    record.keySha256 !== keySha256(publicKey)
  ) {
    return null;
  }
  // The bucket is ours alone, but check the stored certificate matches its record anyway.
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(record.certificate);
  } catch {
    return null;
  }
  if (
    serialOf(cert) !== record.serial ||
    keySha256(cert.publicKey) !== record.keySha256
  ) {
    return null;
  }
  return { certificate: record.certificate, notAfter: cert.validToDate };
}

function objectName(machine: string): string {
  if (!MACHINE_NAME.test(machine)) throw new Error('not a machine name');
  return `machines/${machine}.json`;
}

/** The records in a Cloud Storage bucket. */
export function gcsNewestRecords(
  bucket: string,
  accessToken: () => Promise<string>,
  fetcher: typeof fetch = fetch,
): NewestRecords {
  if (!BUCKET_NAME.test(bucket)) throw new Error('not a bucket name');
  const request = async (url: string, init: RequestInit = {}) =>
    fetcher(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        ...init.headers,
      },
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

  return {
    async read(machine) {
      const name = encodeURIComponent(objectName(machine));
      const res = await request(
        `${STORAGE}/storage/v1/b/${bucket}/o/${name}?alt=media`,
      );
      if (res.status === 404) return null;
      // Only the status: Google's error text can name the caller's account.
      if (!res.ok) throw new Error(`Cloud Storage answered ${res.status}`);
      const generation = res.headers.get('x-goog-generation') ?? '';
      const body = (await res.json()) as Record<string, unknown>;
      const { serial, notAfter, keySha256, certificate, previousSerial } = body;
      const optional = (value: unknown, pattern: RegExp) =>
        value === undefined ||
        (typeof value === 'string' && pattern.test(value));
      if (
        !/^[0-9]+$/.test(generation) ||
        typeof serial !== 'string' ||
        !SERIAL.test(serial) ||
        typeof notAfter !== 'string' ||
        !optional(keySha256, SHA256) ||
        !optional(certificate, PEM_CERTIFICATE) ||
        !optional(previousSerial, SERIAL)
      ) {
        throw new Error('the machine record is malformed');
      }
      return {
        serial,
        notAfter,
        generation,
        ...(keySha256 === undefined ? {} : { keySha256: keySha256 as string }),
        ...(certificate === undefined
          ? {}
          : { certificate: certificate as string }),
        ...(previousSerial === undefined
          ? {}
          : { previousSerial: previousSerial as string }),
      };
    },

    async write(machine, newest, ifGeneration) {
      const query = new URLSearchParams({
        uploadType: 'media',
        name: objectName(machine),
      });
      if (ifGeneration !== undefined) {
        query.set('ifGenerationMatch', ifGeneration);
      }
      const res = await request(
        `${STORAGE}/upload/storage/v1/b/${bucket}/o?${query}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            serial: newest.serial,
            notAfter: newest.notAfter,
            keySha256: newest.keySha256,
            certificate: newest.certificate,
            previousSerial: newest.previousSerial,
          }),
        },
      );
      if (res.status === 412) return false;
      if (!res.ok) throw new Error(`Cloud Storage answered ${res.status}`);
      return true;
    },
  };
}
