import { verify } from 'node:crypto';
import type { ClerkConfig } from './clerk-config';
import { isRole, type Role, ROLE_CLAIM } from '@heisreal/roles';

/** Why a token was refused (logged, never sent to the caller). */
export type ClerkTokenFailure =
  | 'malformed'
  | 'algorithm'
  | 'signature'
  | 'expired'
  | 'not_yet_valid'
  | 'issued_in_future'
  | 'issuer'
  | 'authorized_party'
  | 'subject'
  | 'session_status'
  | 'role';

export class ClerkTokenError extends Error {
  constructor(readonly reason: ClerkTokenFailure) {
    super(`Clerk session token refused: ${reason}`);
    this.name = 'ClerkTokenError';
  }
}

export interface VerifiedClerkToken {
  /** `sub`: the Clerk user id. */
  clerkUserId: string;
  /** The {@link ROLE_CLAIM} claim (D1). */
  role: Role;
  /** The compact token itself, unchanged: it also opens the person's SurrealDB session (D27). */
  token: string;
}

/** Clerk session tokens are about 1 KB; anything far larger is refused before parsing. */
const MAX_TOKEN_LENGTH = 8192;
const SEGMENT = /^[A-Za-z0-9_-]+$/;
const CLERK_USER_ID = /^user_[A-Za-z0-9]{1,64}$/;

function decodeJson(segment: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    throw new ClerkTokenError('malformed');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ClerkTokenError('malformed');
  }
  return value as Record<string, unknown>;
}

const isNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);

/**
 * Verifies a Clerk session token without the network (manual JWT verification, as Clerk
 * documents it):
 * - RS256 only, against the pinned public key (no `alg: none`, no HS256 with the public key,
 *   no `jku`/`jwk`/`x5u` header keys, no `crit`);
 * - `exp` and `nbf` are required, and `iat` must not be in the future, each with
 *   `clockSkewSeconds` of leeway;
 * - `iss` must be the configured instance, `azp` one of the allowed origins (SurrealDB checks
 *   neither), `sub` a Clerk user id, a pending session (`sts` other than `active`) is refused;
 * - the role claim must be one of {@link ROLES}.
 *
 * Throws {@link ClerkTokenError} on any failure. SurrealDB verifies the same signature and
 * `exp`/`nbf` again when the token opens a person session.
 */
export function verifyClerkToken(
  token: string,
  config: ClerkConfig,
  nowSeconds = Date.now() / 1000,
): VerifiedClerkToken {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) {
    throw new ClerkTokenError('malformed');
  }
  const parts = token.split('.');
  if (parts.length !== 3 || !parts.every((p) => SEGMENT.test(p))) {
    throw new ClerkTokenError('malformed');
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts;

  const header = decodeJson(encodedHeader);
  if (header['alg'] !== 'RS256') throw new ClerkTokenError('algorithm');
  if (header['typ'] !== undefined && header['typ'] !== 'JWT') {
    throw new ClerkTokenError('malformed');
  }
  if (['crit', 'jku', 'jwk', 'x5u', 'x5c'].some((k) => k in header)) {
    throw new ClerkTokenError('malformed');
  }

  const signed = verify(
    'RSA-SHA256',
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    config.publicKey,
    Buffer.from(encodedSignature, 'base64url'),
  );
  if (!signed) throw new ClerkTokenError('signature');

  const claims = decodeJson(encodedPayload);
  const skew = config.clockSkewSeconds;
  const { exp, nbf, iat } = claims;
  if (!isNumber(exp) || !isNumber(nbf)) throw new ClerkTokenError('malformed');
  if (nowSeconds - skew >= exp) throw new ClerkTokenError('expired');
  if (nowSeconds + skew < nbf) throw new ClerkTokenError('not_yet_valid');
  if (iat !== undefined && (!isNumber(iat) || nowSeconds + skew < iat)) {
    throw new ClerkTokenError('issued_in_future');
  }

  if (claims['iss'] !== config.issuer) throw new ClerkTokenError('issuer');
  const azp = claims['azp'];
  if (typeof azp !== 'string' || !config.authorizedParties.has(azp)) {
    throw new ClerkTokenError('authorized_party');
  }
  const sub = claims['sub'];
  if (typeof sub !== 'string' || !CLERK_USER_ID.test(sub)) {
    throw new ClerkTokenError('subject');
  }
  // v2 tokens: `sts` is the session status; a pending session (e.g. unfinished tasks) is
  // treated as signed out, as Clerk's own SDKs do.
  if (claims['sts'] !== undefined && claims['sts'] !== 'active') {
    throw new ClerkTokenError('session_status');
  }
  const role = claims[ROLE_CLAIM];
  if (!isRole(role)) throw new ClerkTokenError('role');

  return { clerkUserId: sub, role, token };
}
