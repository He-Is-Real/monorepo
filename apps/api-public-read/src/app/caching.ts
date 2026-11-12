import { createHash } from 'node:crypto';
import type { Response } from 'express';

/** R13 (Joel, 2026-11-05): a public answer is at most 60 seconds old, end to end. */
export const PUBLIC_MAX_AGE_SECONDS = 60;

/**
 * D51: API responses are `no-store` in dev, so a story that is hidden, taken down to edit, deleted or erased
 * disappears from browsers and CDNs at once (this service's own memory keeps it at most a minute,
 * R13). Shared caching needs `PUBLIC_RESPONSE_CACHING=on`, which no environment sets yet (Go
 * live's front door decides it, D56). Anything else fails safe. When on, a public query may be
 * kept for the `seconds` its answer has left, and never served stale beyond them (no
 * `stale-while-revalidate`): 60 seconds is the total (R13). An answer with no time left is
 * `no-store`. Signed media links outlive that by
 * hours (D52).
 */
export function publicCacheControl(seconds = PUBLIC_MAX_AGE_SECONDS): string {
  return process.env['PUBLIC_RESPONSE_CACHING'] === 'on' && seconds > 0
    ? `public, max-age=${seconds}`
    : 'no-store';
}

/**
 * A strong validator of exactly what's sent: a hash of the JSON body, which is what Nest
 * serialises. Not the story's `version` alone, because the response embeds its themes by
 * reference (#45 review): renaming a theme changes the body, so the ETag must change too.
 */
export function representationETag(body: unknown): string {
  return `"${createHash('sha256').update(JSON.stringify(body)).digest('base64url').slice(0, 27)}"`;
}

/** Collections take a weak, representation-based ETag (D29). */
export function collectionETag(body: unknown): string {
  return `W/${representationETag(body)}`;
}

/** `If-None-Match` matches (also `*` and lists): the weak comparison of RFC 9110. */
export function ifNoneMatchHits(
  ifNoneMatch: string | undefined,
  etag: string,
): boolean {
  if (!ifNoneMatch) return false;
  const opaque = etag.replace(/^W\//, '');
  return ifNoneMatch
    .split(',')
    .map((t) => t.trim().replace(/^W\//, ''))
    .some((t) => t === '*' || t === opaque);
}

/**
 * Marks `body` as a public answer with its validator. PublicCacheInterceptor (public-cache.ts)
 * keeps it, answers `If-None-Match` with `304` and sets `Cache-Control`. Returns what the handler
 * returns (Nest's passthrough response).
 */
export function withETag<T>(res: Response, body: T, etag: string): T {
  res.setHeader('ETag', etag);
  return body;
}
