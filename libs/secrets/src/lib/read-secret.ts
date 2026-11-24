import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { requireEnv } from './env';
import { withTimeout } from './timeout';

/** The subset of the Secret Manager client used to read a secret; tests pass a fake. */
export interface SecretVersionReader {
  accessSecretVersion(request: {
    name: string;
  }): Promise<
    [{ payload?: { data?: Uint8Array | string | null } | null }, ...unknown[]]
  >;
}

/** The text of one secret version (`projects/…/secrets/…/versions/…`), or an error. */
export async function accessSecret(
  client: SecretVersionReader,
  name: string,
  timeoutMs: number,
): Promise<string> {
  const [response] = await withTimeout(
    client.accessSecretVersion({ name }),
    timeoutMs,
    `Reading secret ${name}`,
  );
  const data = response.payload?.data;
  if (data === undefined || data === null) {
    throw new Error(`Secret ${name} has no payload`);
  }
  return typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
}

/**
 * Reads the latest version of `secretId` in `GCP_PROJECT` once, without Nest: for code that
 * isn't a Nest service (the website's server reads its log keys at start-up with it,
 * `@heisreal/secrets/read`). Application Default Credentials, as {@link SecretsService}.
 */
export async function readSecret(
  secretId: string,
  {
    project = requireEnv('GCP_PROJECT'),
    client = new SecretManagerServiceClient() as unknown as SecretVersionReader,
    timeoutMs = 15_000,
  }: {
    project?: string;
    client?: SecretVersionReader;
    timeoutMs?: number;
  } = {},
): Promise<string> {
  return accessSecret(
    client,
    `projects/${project}/secrets/${secretId}/versions/latest`,
    timeoutMs,
  );
}
