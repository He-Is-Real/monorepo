/**
 * "Newest only" (W2-1 A; Joel, 2026-11-09, worker-and-gcloud-sign-in.html): the signing service
 * renews a machine's certificate only if it is the newest one issued for that machine. The newest
 * one's serial and expiry are one small JSON object per machine in a private London Cloud Storage
 * bucket (infra/terraform/modules/gcp/worker_identity.tf); not a database. A copied certificate
 * and key can't keep a second line of renewals going: whichever copy renews first makes the other
 * one stale, and its next renewal is refused.
 *
 * Writes carry the generation that was read (ifGenerationMatch), so two renewals of the same
 * certificate can't both win. Plain REST, like kms.ts: the caller passes its own access token
 * (cert-signer's account on Cloud Run; a developer's gcloud login for enrol).
 */
import type { X509Certificate } from 'node:crypto';
import { MACHINE_NAME } from './certificates';

/** The newest certificate issued for a machine. */
export interface NewestCertificate {
  /** Upper-case hex, as X509Certificate.serialNumber gives it. */
  serial: string;
  /** ISO 8601. */
  notAfter: string;
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

export function newestOf(cert: X509Certificate): NewestCertificate {
  return {
    serial: cert.serialNumber.toUpperCase(),
    notAfter: cert.validToDate.toISOString(),
  };
}

/** Is `cert` the machine's newest certificate? */
export function isNewest(
  cert: X509Certificate,
  record: NewestCertificate | null,
): boolean {
  return record !== null && record.serial === newestOf(cert).serial;
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
      const { serial, notAfter } = body;
      if (
        !/^[0-9]+$/.test(generation) ||
        typeof serial !== 'string' ||
        !SERIAL.test(serial) ||
        typeof notAfter !== 'string'
      ) {
        throw new Error('the machine record is malformed');
      }
      return { serial, notAfter, generation };
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
          }),
        },
      );
      if (res.status === 412) return false;
      if (!res.ok) throw new Error(`Cloud Storage answered ${res.status}`);
      return true;
    },
  };
}
