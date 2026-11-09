/**
 * Google sign-in with the worker's certificate (W1-A): workload identity federation with X.509
 * certificates. Google's libraries do the exchange themselves from a standard external_account
 * credential configuration (the same one `gcloud iam workload-identity-pools create-cred-config`
 * writes for a certificate): mTLS to Google's token service with the current certificate, then a
 * 1-hour token acting as media-worker. The certificate and key sit at one fixed path that renewal
 * renames a new pair over (store.ts), and both libraries read that file again on every refresh,
 * so a renewed certificate is picked up without a restart. Used by the worker (Node) and Dapr's
 * sidecar (Go) alike, through GOOGLE_APPLICATION_CREDENTIALS.
 */
import { ExternalAccountClient } from 'google-auth-library';
import type { IdentityInfo } from './store';

export function credentialConfig(
  info: IdentityInfo,
  certificateConfigPath: string,
): Record<string, unknown> {
  return {
    universe_domain: 'googleapis.com',
    type: 'external_account',
    audience: `//iam.googleapis.com/projects/${info.projectNumber}/locations/global/workloadIdentityPools/${info.pool}/providers/${info.provider}`,
    subject_token_type: 'urn:ietf:params:oauth:token-type:mtls',
    // Certificate sign-in is mTLS only, so both endpoints are Google's mTLS ones.
    token_url: 'https://sts.mtls.googleapis.com/v1/token',
    service_account_impersonation_url: `https://iamcredentials.mtls.googleapis.com/v1/projects/-/serviceAccounts/${info.serviceAccount}:generateAccessToken`,
    credential_source: {
      certificate: { certificate_config_location: certificateConfigPath },
    },
  };
}

/** Renew an ID token this long before it expires (they last an hour). */
const ID_TOKEN_MARGIN_MS = 5 * 60_000;

function expiry(token: string): number {
  const payload = JSON.parse(
    Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
  ) as { exp?: unknown };
  return typeof payload.exp === 'number' ? payload.exp * 1000 : 0;
}

/** What idTokens needs of Google's client (tests pass their own). */
export interface TokenClient {
  request<T>(options: {
    url: string;
    method: 'POST';
    data: unknown;
    responseType: 'json';
  }): Promise<{ data: T }>;
}

/**
 * Google ID tokens as media-worker, for Cloud Run (the result writer, the signing service).
 * The external_account client has no ID tokens of its own, so the federated identity (the
 * machine's principal, which holds roles/iam.workloadIdentityUser on media-worker only) asks
 * IAM Credentials for one, over mTLS with the current certificate. Cached per audience.
 *
 * A failed sign-in is tried once more at once. google-auth-library (11.3,
 * certificatesubjecttokensupplier.js) reads the certificate and the key with two separate reads
 * of keys/current.pem; each read sees one whole file (renewal renames, never rewrites in place),
 * but a renewal between the two can pair the old certificate with the new key, and that one TLS
 * handshake fails. The next try reads both again from the one new file.
 */
export function idTokens(
  credentials: Record<string, unknown>,
  serviceAccount: string,
  client: TokenClient = externalAccountClient(credentials),
): (audience: string) => Promise<string> {
  const cache = new Map<string, { token: string; expires: number }>();
  return async (audience) => {
    const hit = cache.get(audience);
    if (hit && hit.expires - ID_TOKEN_MARGIN_MS > Date.now()) return hit.token;
    const ask = () =>
      client.request<{ token?: string }>({
        url: `https://iamcredentials.mtls.googleapis.com/v1/projects/-/serviceAccounts/${serviceAccount}:generateIdToken`,
        method: 'POST',
        data: { audience, includeEmail: true },
        responseType: 'json',
      });
    const res = await ask().catch(ask);
    const token = res.data.token;
    if (!token) throw new Error('IAM Credentials returned no ID token');
    cache.set(audience, { token, expires: expiry(token) });
    return token;
  };
}

/** The machine's own federated client: the configuration without the impersonation step. */
function externalAccountClient(
  credentials: Record<string, unknown>,
): TokenClient {
  const federated = { ...credentials };
  delete federated['service_account_impersonation_url'];
  const client = ExternalAccountClient.fromJSON(
    federated as unknown as Parameters<
      typeof ExternalAccountClient.fromJSON
    >[0],
  );
  if (!client)
    throw new Error('not an external_account credential configuration');
  return client;
}
