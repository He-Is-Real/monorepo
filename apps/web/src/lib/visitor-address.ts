import { canonicalIp } from '@heisreal/http/rate-limits';

/**
 * The visitor's IP address, for rate limiting only (RL-8 A, Joel 2026-11-21; D32's second
 * carve-out, apps/web/README.md): the last `X-Forwarded-For` entry, the one Google's front end
 * appended to the request (anything before it is whatever the visitor sent). It is used as a
 * counter key in this copy's memory and never logged, stored or forwarded. Undefined if it isn't
 * an IP address. Lint allows this file to read that one header and nothing else.
 */
export function visitorAddress(request: {
  headers: Headers;
}): string | undefined {
  const forwarded = request.headers.get('x-forwarded-for');
  return canonicalIp(forwarded?.split(',').at(-1)?.trim());
}
