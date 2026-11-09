/**
 * Our certificate authority's key: a Cloud KMS asymmetric signing key (EC_SIGN_P256_SHA256,
 * infra/terraform/modules/gcp/worker_identity.tf). KMS signs a digest and never hands the key
 * out. Plain REST, so the signing service, the enrol command and the CA command need no KMS
 * client library: each passes its own access token (the service's account on Cloud Run; a
 * developer's gcloud login for `worker-identity.sh`).
 */
import { createHash, createPublicKey, type KeyObject } from 'node:crypto';
import type { Signer } from './certificates';

export const KMS_KEY_VERSION =
  /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/locations\/[a-z0-9-]+\/keyRings\/[A-Za-z0-9_-]{1,63}\/cryptoKeys\/[A-Za-z0-9_-]{1,63}\/cryptoKeyVersions\/[0-9]{1,6}$/;

const KMS = 'https://cloudkms.googleapis.com/v1';
const TIMEOUT_MS = 15_000;

function checked(keyVersion: string): string {
  if (!KMS_KEY_VERSION.test(keyVersion)) {
    throw new Error('not a Cloud KMS key version name');
  }
  return keyVersion;
}

async function call(
  url: string,
  token: string,
  fetcher: typeof fetch,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const res = await fetcher(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    // Only the status: Google's error text can name the caller's account.
    throw new Error(`Cloud KMS answered ${res.status}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

/** Signs with the KMS key version; the certificate code verifies every signature it gets. */
export function kmsSigner(
  keyVersion: string,
  accessToken: () => Promise<string>,
  fetcher: typeof fetch = fetch,
): Signer {
  const url = `${KMS}/${checked(keyVersion)}:asymmetricSign`;
  return async (data) => {
    const digest = createHash('sha256').update(data).digest('base64');
    const reply = await call(url, await accessToken(), fetcher, {
      digest: { sha256: digest },
    });
    if (typeof reply['signature'] !== 'string') {
      throw new Error('Cloud KMS returned no signature');
    }
    return Buffer.from(reply['signature'], 'base64');
  };
}

/** The KMS key version's public key (for the CA certificate). */
export async function kmsPublicKey(
  keyVersion: string,
  accessToken: string,
  fetcher: typeof fetch = fetch,
): Promise<KeyObject> {
  const reply = await call(
    `${KMS}/${checked(keyVersion)}/publicKey`,
    accessToken,
    fetcher,
  );
  if (typeof reply['pem'] !== 'string') {
    throw new Error('Cloud KMS returned no public key');
  }
  return createPublicKey(reply['pem']);
}
