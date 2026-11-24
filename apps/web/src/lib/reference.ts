/**
 * The reference people see under an error (LG-1, LG-1b A, LG-4 A; Joel 22–24 Nov 2026): a UUID
 * v7, unique for every error. The browser makes one before each call to our APIs and sends it as
 * the W3C `traceparent` trace id (the same 128 bits without dashes), so the API's wide event
 * carries it as `ref`; when there is nothing to link (a crash in the page, a page that couldn't
 * load), the error screen makes a fresh one. It is the same kind of id either way: searching the
 * logs for it answers whether anything reached us, and its first 48 bits are the millisecond it
 * was made. No tracing library. Works in the browser and on the server (Web Crypto).
 */

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** A new UUID v7 (RFC 9562): 48 bits of Unix milliseconds, version 7, then random bits. */
export function newReference(now: number = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let ms = Math.max(0, Math.floor(now));
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = hex(bytes);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * The W3C `traceparent` header for a call whose reference is `reference`: version 00, the
 * reference without dashes as the trace id, a random parent id, sampled.
 */
export function traceparent(reference: string): string {
  const parent = hex(crypto.getRandomValues(new Uint8Array(8)));
  return `00-${reference.replace(/-/g, '')}-${parent}-01`;
}

/** The reference carried by an error from one of our API calls, if it has one. */
export function referenceOf(err: unknown): string | undefined {
  const ref = (err as { reference?: unknown } | null)?.reference;
  return typeof ref === 'string' ? ref : undefined;
}
