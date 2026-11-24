import { canonicalIp } from '@heisreal/http/rate-limits';

/**
 * The few request headers web's server reads (D32's second carve-out, apps/web/README.md;
 * eslint.config.mjs lets only this file read them, each by its literal name). Never a cookie,
 * a token or a whole header set.
 *
 * - `x-forwarded-for`: the visitor's address, for rate limiting (RL-8 A, Joel 2026-11-21) and,
 *   plain, as the request's `client.ip` (LG-2, Joel 23 Nov 2026); on a search event only as a
 *   search-key hash (LG-2g A).
 * - `user-agent`: the request's `client.user_agent`, plain (bot detection, Joel 23 Nov 2026).
 * - `traceparent`: the W3C trace Google's front end gives the request (LG-4 A), so our event's
 *   `ref` and trace field match Cloud Run's own request line.
 * - `next-router-prefetch`: whether Next's router is only prefetching a page, which is not a
 *   search someone made (LG-2g A).
 *
 * Nothing here is stored or forwarded; the logs write them as the logging rules say.
 */

/**
 * The visitor's IP address: the last `X-Forwarded-For` entry, the one Google's front end
 * appended to the request (anything before it is whatever the visitor sent). Undefined if it
 * isn't an IP address.
 */
export function visitorAddress(request: {
  headers: Headers;
}): string | undefined {
  const forwarded = request.headers.get('x-forwarded-for');
  return canonicalIp(forwarded?.split(',').at(-1)?.trim());
}

/** The visitor's browser, as it names itself. */
export function visitorUserAgent(request: {
  headers: Headers;
}): string | undefined {
  return request.headers.get('user-agent') ?? undefined;
}

/** The request's `traceparent`, if any. */
export function requestTraceparent(request: {
  headers: Headers;
}): string | undefined {
  return request.headers.get('traceparent') ?? undefined;
}

/** Whether Next's router is only prefetching this page. */
export function isPrefetch(request: { headers: Headers }): boolean {
  return request.headers.get('next-router-prefetch') !== null;
}

/** The `traceparent` of a request Next reports an error on (`onRequestError`'s plain headers). */
export function erroredRequestTraceparent(request: {
  headers: Record<string, string | string[] | undefined>;
}): string | undefined {
  const value = request.headers.traceparent;
  return Array.isArray(value) ? value[0] : value;
}
