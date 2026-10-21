import { createPublicKey, type KeyObject } from 'node:crypto';
import { requireEnv } from '@heisreal/secrets';

/** Injection token for the {@link ClerkConfig}. */
export const CLERK_CONFIG = Symbol('CLERK_CONFIG');

/**
 * How api-user and api-admin verify Clerk session tokens. Everything is public, so nothing
 * here comes from Secret Manager, and verification needs no network: the instance's PEM key is
 * pinned like SurrealDB's (`clerk_jwt_public_key`), so no JWKS fetch and no secret key.
 */
export interface ClerkConfig {
  /** The instance's Frontend API URL, the tokens' `iss`, e.g. `https://superb-mink-8967.clerk.accounts.dev`. */
  issuer: string;
  /** Clerk's RS256 public key (Dashboard → API keys → "JWKS Public Key", PEM). */
  publicKey: KeyObject;
  /** Origins allowed in `azp`: the `web` Cloud Run URL, plus localhost in dev. */
  authorizedParties: ReadonlySet<string>;
  /** Leeway for `exp`/`nbf`/`iat`. Clerk tokens live 60 s and Clerk's own default skew is 5 s. */
  clockSkewSeconds: number;
}

export const DEFAULT_CLOCK_SKEW_SECONDS = 5;

export class ClerkConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClerkConfigError';
  }
}

export interface ClerkConfigInput {
  issuer: string;
  /** PEM; `\n` escapes are accepted, for env files that hold it on one line. */
  publicKeyPem: string;
  /** Comma- or whitespace-separated origins. */
  authorizedParties: string;
  clockSkewSeconds?: number;
}

/** Validates the settings once, at startup, so a misconfiguration stops the service. */
export function parseClerkConfig(input: ClerkConfigInput): ClerkConfig {
  let issuer: URL;
  try {
    issuer = new URL(input.issuer);
  } catch {
    throw new ClerkConfigError(`CLERK_ISSUER is not a URL: ${input.issuer}`);
  }
  if (
    issuer.protocol !== 'https:' ||
    issuer.origin !== input.issuer.replace(/\/+$/, '')
  ) {
    throw new ClerkConfigError(
      `CLERK_ISSUER must be the instance's https origin (no path): ${input.issuer}`,
    );
  }

  const pem = input.publicKeyPem.replace(/\\n/g, '\n').trim();
  if (pem.includes('PRIVATE')) {
    throw new ClerkConfigError(
      'CLERK_JWT_PUBLIC_KEY holds a private key; it must be the public key',
    );
  }
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey({ key: pem, format: 'pem' });
  } catch {
    throw new ClerkConfigError('CLERK_JWT_PUBLIC_KEY is not a PEM public key');
  }
  const bits = publicKey.asymmetricKeyDetails?.modulusLength ?? 0;
  if (publicKey.asymmetricKeyType !== 'rsa' || bits < 2048) {
    throw new ClerkConfigError(
      'CLERK_JWT_PUBLIC_KEY must be an RSA key of at least 2048 bits (Clerk signs RS256)',
    );
  }

  const parties = input.authorizedParties
    .split(/[\s,]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parties.length) {
    throw new ClerkConfigError(
      'CLERK_AUTHORIZED_PARTIES is empty: list the origins allowed in azp',
    );
  }
  for (const party of parties) {
    let url: URL;
    try {
      url = new URL(party);
    } catch {
      throw new ClerkConfigError(
        `Not an origin in CLERK_AUTHORIZED_PARTIES: ${party}`,
      );
    }
    const local = ['localhost', '127.0.0.1'].includes(url.hostname);
    if (url.origin !== party || (url.protocol !== 'https:' && !local)) {
      throw new ClerkConfigError(
        `CLERK_AUTHORIZED_PARTIES takes origins (https, or http only for localhost): ${party}`,
      );
    }
  }

  const clockSkewSeconds = input.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
  if (
    !Number.isInteger(clockSkewSeconds) ||
    clockSkewSeconds < 0 ||
    clockSkewSeconds > 30
  ) {
    throw new ClerkConfigError('The clock skew must be 0–30 seconds');
  }

  return {
    issuer: issuer.origin,
    publicKey,
    authorizedParties: new Set(parties),
    clockSkewSeconds,
  };
}

/** Reads `CLERK_ISSUER`, `CLERK_JWT_PUBLIC_KEY` and `CLERK_AUTHORIZED_PARTIES`. */
export function clerkConfigFromEnv(): ClerkConfig {
  return parseClerkConfig({
    issuer: requireEnv('CLERK_ISSUER'),
    publicKeyPem: requireEnv('CLERK_JWT_PUBLIC_KEY'),
    authorizedParties: requireEnv('CLERK_AUTHORIZED_PARTIES'),
  });
}
