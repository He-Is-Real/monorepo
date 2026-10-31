import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Clerk sends its webhooks through Svix, signed as Svix documents
 * (https://docs.svix.com/receiving/verifying-payloads/how-manual): the HMAC-SHA256, keyed with the
 * base64 part of the endpoint's `whsec_…` secret, of `<svix-id>.<svix-timestamp>.<raw body>`,
 * base64-encoded. `svix-signature` lists one or more `v1,<signature>` (several while a secret is
 * being rotated); one match is enough. The timestamp must be within five minutes of now, so a
 * captured request can't be replayed later.
 */
export class SvixVerificationError extends Error {
  override name = 'SvixVerificationError';
}

/** Svix's tolerance for the timestamp, either way. */
const TOLERANCE_SECONDS = 5 * 60;
const SECRET = /^whsec_([A-Za-z0-9+/]+={0,2})$/;

export interface SvixHeaders {
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
}

/** The secret's key bytes; throws if it isn't a `whsec_` secret. */
export function svixKey(secret: string): Buffer {
  const match = SECRET.exec(secret.trim());
  const key = match ? Buffer.from(match[1], 'base64') : Buffer.alloc(0);
  if (key.length < 16) throw new Error('Not a Svix signing secret (whsec_…)');
  return key;
}

/** Throws `SvixVerificationError` unless the request is signed with `key`, recently. */
export function verifySvix(
  key: Buffer,
  headers: SvixHeaders,
  body: Buffer,
  nowSeconds = Math.floor(Date.now() / 1000),
): void {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) {
    throw new SvixVerificationError('missing Svix headers');
  }
  if (!/^[0-9]{1,12}$/.test(timestamp)) {
    throw new SvixVerificationError('bad timestamp');
  }
  if (Math.abs(nowSeconds - Number(timestamp)) > TOLERANCE_SECONDS) {
    throw new SvixVerificationError('timestamp outside the tolerance');
  }
  const expected = createHmac('sha256', key)
    .update(`${id}.${timestamp}.`)
    .update(body)
    .digest();
  const matches = signature.split(' ').some((entry) => {
    const [version, value] = entry.split(',', 2);
    if (version !== 'v1' || !value) return false;
    const given = Buffer.from(value, 'base64');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!matches) throw new SvixVerificationError('no matching signature');
}
