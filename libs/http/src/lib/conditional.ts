import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';

/** A weak, representation-based validator for composite views (D29). */
export function weakETag(body: unknown): string {
  const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  return `W/"${hash.slice(0, 32)}"`;
}

/** Whether `If-None-Match` matches `etag` (weak comparison, RFC 9110 §13.1.2), so `304`. */
export function ifNoneMatches(
  ifNoneMatch: string | undefined,
  etag: string,
): boolean {
  if (!ifNoneMatch) return false;
  const bare = (t: string) => t.trim().replace(/^W\//, '');
  return ifNoneMatch
    .split(',')
    .some((t) => t.trim() === '*' || bare(t) === bare(etag));
}

/** A command's `Idempotency-Key` header (D29): 16–128 characters, else `400`. */
export function parseIdempotencyKey(header: string | undefined): string {
  if (!header || header.length < 16 || header.length > 128) {
    throw new BadRequestException({
      code: 'idempotency_key_required',
      message:
        'This command needs an Idempotency-Key header (16–128 characters)',
    });
  }
  return header;
}

/** `table:id` → `id`: the contracts' IDs are opaque record keys without the table. */
export function recordKey(id: string): string {
  const key = id.slice(id.indexOf(':') + 1);
  return key.startsWith('⟨') && key.endsWith('⟩') ? key.slice(1, -1) : key;
}
