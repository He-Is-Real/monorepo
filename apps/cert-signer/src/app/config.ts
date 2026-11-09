import { X509Certificate } from 'node:crypto';
import {
  BUCKET_NAME,
  KMS_KEY_VERSION,
  MACHINE_NAME,
  MAX_LIFETIME_HOURS,
} from '@heisreal/worker-identity';

/** The signing service's settings, all from OpenTofu (infra/terraform/modules/gcp/worker_identity.tf). */
export interface SignerConfig {
  /** Our authority's certificate: what a worker's current certificate must be signed by. */
  ca: X509Certificate;
  /** The machines that may hold a certificate; the same list Google's provider allows. */
  allowed: ReadonlySet<string>;
  /** How long a new certificate is valid (default 24 hours; Joel, 2026-11-08, W1-A). */
  lifetimeHours: number;
  /** The authority's Cloud KMS key version. */
  kmsKeyVersion: string;
  /** The private bucket holding each machine's newest certificate (W2-1 A; newest.ts). */
  recordsBucket: string;
}

export const SIGNER_CONFIG = Symbol('SIGNER_CONFIG');
export const SIGNER = Symbol('SIGNER');
export const NEWEST = Symbol('NEWEST');

function env(source: NodeJS.ProcessEnv, name: string): string {
  const value = source[name];
  if (!value) throw new Error(`${name} is missing`);
  return value;
}

/** Reads and checks the settings; a bad one stops the service at start-up. */
export function signerConfig(
  source: NodeJS.ProcessEnv = process.env,
): SignerConfig {
  const ca = new X509Certificate(env(source, 'CA_CERTIFICATE'));
  if (!ca.ca) throw new Error('CA_CERTIFICATE is not a CA certificate');
  // Empty is a real setting: the last machine was cancelled, so the service runs and refuses
  // everyone. Absent is a broken deployment and stops it.
  const machines = source['ALLOWED_MACHINES'];
  if (machines === undefined) throw new Error('ALLOWED_MACHINES is missing');
  const allowed = new Set(
    machines
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean),
  );
  for (const machine of allowed) {
    if (!MACHINE_NAME.test(machine)) {
      throw new Error('ALLOWED_MACHINES holds a malformed name');
    }
  }
  const lifetimeHours = Number(env(source, 'CERTIFICATE_LIFETIME_HOURS'));
  if (
    !Number.isInteger(lifetimeHours) ||
    lifetimeHours < 1 ||
    lifetimeHours > MAX_LIFETIME_HOURS
  ) {
    throw new Error('CERTIFICATE_LIFETIME_HOURS is out of range');
  }
  const kmsKeyVersion = env(source, 'KMS_KEY_VERSION');
  if (!KMS_KEY_VERSION.test(kmsKeyVersion)) {
    throw new Error('KMS_KEY_VERSION is malformed');
  }
  const recordsBucket = env(source, 'CERTIFICATE_RECORDS_BUCKET');
  if (!BUCKET_NAME.test(recordsBucket)) {
    throw new Error('CERTIFICATE_RECORDS_BUCKET is malformed');
  }
  return { ca, allowed, lifetimeHours, kmsKeyVersion, recordsBucket };
}
