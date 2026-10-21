import {
  createHmac,
  generateKeyPairSync,
  KeyObject,
  randomUUID,
  sign,
} from 'node:crypto';

/**
 * Stand-in for a Clerk instance: an RS256 key pair generated per test run. The public half
 * is pinned into `DEFINE ACCESS clerk` exactly as Terraform will pin Clerk's PEM public key
 * (GKE has no internet egress, so SurrealDB can't fetch Clerk's JWKS).
 */
export interface SigningKeys {
  publicKeyPem: string;
  privateKey: KeyObject;
}

export function newSigningKeys(): SigningKeys {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey,
  };
}

const b64url = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

/** Signs a compact JWS with RS256. */
export function signRs256(
  claims: Record<string, unknown>,
  key: KeyObject,
): string {
  const input = `${b64url({ alg: 'RS256', typ: 'JWT', kid: 'ins_test' })}.${b64url(claims)}`;
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), key).toString('base64url')}`;
}

/** Algorithm-confusion attempt: HS256 with the *public* PEM as the HMAC secret. */
export function signHs256WithPublicKey(
  claims: Record<string, unknown>,
  publicKeyPem: string,
): string {
  const input = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(claims)}`;
  return `${input}.${createHmac('sha256', publicKeyPem).update(input).digest('base64url')}`;
}

export interface ClerkTokenOptions {
  namespace: string;
  database: string;
  /** Seconds from now; negative for an expired token. Clerk session tokens live 60 s. */
  expiresIn?: number;
  /** Extra or overriding claims. */
  claims?: Record<string, unknown>;
}

/**
 * The claims a Clerk session token carries once the JWT template adds `ns`, `db` and `ac`
 * (see docs/db-permissions.md, "Clerk side"). `sub` is the Clerk user ID.
 */
export function clerkClaims(
  clerkUserId: string,
  options: ClerkTokenOptions,
): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    // Clerk's default (v2) session-token claims, so SurrealDB is shown to tolerate all of them.
    // https://clerk.com/docs/guides/sessions/session-tokens (values are illustrative)
    azp: 'http://localhost:3000',
    exp: now + (options.expiresIn ?? 60),
    fva: [0, -1],
    iat: now,
    iss: 'https://example.clerk.accounts.dev',
    jti: randomUUID().replace(/-/g, '').slice(0, 20),
    nbf: now - 5,
    sid: `sess_${randomUUID()}`,
    sts: 'active',
    sub: clerkUserId,
    v: 2,
    pla: 'u:free_user',
    fea: 'u:basic',
    // Added as custom session-token claims (or by a JWT template) so SurrealDB routes the token
    // to DEFINE ACCESS clerk.
    ns: options.namespace,
    db: options.database,
    ac: 'clerk',
    ...options.claims,
  };
}
