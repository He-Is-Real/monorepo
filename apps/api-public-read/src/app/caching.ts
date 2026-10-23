import { createHash } from 'node:crypto';
import { HttpStatus } from '@nestjs/common';
import type { Response } from 'express';

/**
 * Public queries (D30) when shared caching is on: caches may keep a response for a minute and
 * serve it stale for five more while revalidating. Signed media links outlive that (D52).
 */
export const CACHE_PUBLIC = 'public, max-age=60, stale-while-revalidate=300';

/**
 * D51: API responses are `no-store` in dev, so a story that is hidden, withdrawn or erased
 * disappears on the next request. Shared caching needs `PUBLIC_RESPONSE_CACHING=on`, which no
 * environment sets yet (Go live's front door decides it, D56). Anything else fails safe.
 */
export function publicCacheControl(): string {
  return process.env['PUBLIC_RESPONSE_CACHING'] === 'on'
    ? CACHE_PUBLIC
    : 'no-store';
}

/**
 * A strong validator of exactly what's sent: a hash of the JSON body, which is what Nest
 * serialises. Not the story's `version` alone, because the response embeds its tags by
 * reference (#45 review): renaming a tag changes the body, so the ETag must change too.
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
 * Sends `body` with the public cache policy and its ETag, or `304` with the same headers when the client
 * has it already. Returns what the handler returns (Nest's passthrough response).
 */
export function sendCached<T>(
  res: Response,
  ifNoneMatch: string | undefined,
  body: T,
  etag: string,
): T | undefined {
  res.setHeader('ETag', etag).setHeader('Cache-Control', publicCacheControl());
  if (ifNoneMatchHits(ifNoneMatch, etag)) {
    res.status(HttpStatus.NOT_MODIFIED);
    return undefined;
  }
  return body;
}
