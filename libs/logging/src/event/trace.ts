import { randomBytes } from 'node:crypto';

/**
 * The request's reference (LG-1b A, LG-4 A; Joel 22–24 Nov 2026): a UUID v7, made by the browser
 * before it sends (or by the first service when no browser sent one), travelling as the W3C
 * `traceparent` trace id (the same 128 bits without dashes) and shown to people as their error
 * "Reference". No tracing library.
 */

/** A new UUID v7 (RFC 9562): 48 bits of Unix milliseconds, version 7, then random bits. */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  let ms = BigInt(Math.max(0, Math.floor(now)));
  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number(ms & 0xffn);
    ms >>= 8n;
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return dashed(bytes.toString('hex'));
}

/** 32 hex digits as 8-4-4-4-12. */
export function dashed(hex32: string): string {
  return `${hex32.slice(0, 8)}-${hex32.slice(8, 12)}-${hex32.slice(12, 16)}-${hex32.slice(16, 20)}-${hex32.slice(20)}`;
}

export interface Trace {
  /** The reference people see: the trace id with dashes. */
  ref: string;
  /** The W3C trace id: 32 lower-case hex digits. */
  traceId: string;
}

const TRACEPARENT =
  /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/**
 * The trace a `traceparent` header carries (W3C Trace Context), or undefined when it is missing
 * or not valid (version `ff`, an all-zero trace or parent id): then the service starts its own.
 */
export function traceFromHeader(
  header: string | string[] | undefined,
): Trace | undefined {
  const value = (Array.isArray(header) ? header[0] : header)
    ?.trim()
    .toLowerCase();
  const match = value ? TRACEPARENT.exec(value) : null;
  if (!match) return undefined;
  const [, version, traceId, parentId] = match;
  if (version === 'ff' || /^0+$/.test(traceId) || /^0+$/.test(parentId)) {
    return undefined;
  }
  return { ref: dashed(traceId), traceId };
}

/** A new trace, for work no browser started. */
export function newTrace(now?: number): Trace {
  const ref = uuidv7(now);
  return { ref, traceId: ref.replace(/-/g, '') };
}

/**
 * Cloud Logging's trace field (`logging.googleapis.com/trace`), which groups our line with Cloud
 * Run's own request line: `projects/<project>/traces/<trace id>`. Undefined without a project
 * (a local run).
 */
export function cloudTrace(
  traceId: string,
  project: string | undefined = globalThis.process?.env?.['GCP_PROJECT'],
): string | undefined {
  return project ? `projects/${project}/traces/${traceId}` : undefined;
}

/** The field name Cloud Logging reads the trace from. */
export const TRACE_FIELD = 'logging.googleapis.com/trace';
