/**
 * Reading the Axiom ingest token (`axiom-ingest-token`, Secret Manager) for the log sink and the
 * spans, so that one failed read never turns Axiom off for an instance's whole life.
 *
 * Why (25 Nov 2026, the website's first revision with spans): the spans read the token with their
 * first batch, five seconds after the first request. On Cloud Run (`cpu_idle = true`) an instance
 * gets almost no CPU between requests, so a read that starts after the last response can't finish
 * before its 15 s time cap; it failed, and the failure was kept for good.
 *
 * - Read at start-up (Cloud Run gives a starting instance full CPU), in the background: never
 *   awaited by start-up or by a request.
 * - A failed or empty read is tried again, at most once a minute ({@link TOKEN_RETRY_MS}), by the
 *   next batch that needs the token (spans) or a background timer (logs).
 * - One warning for the first failure, with the error's type and code but never its message (it
 *   could quote a secret's path or more); later failures are silent until a read succeeds.
 */
import { writeLog } from './index';

export const TOKEN_RETRY_MS = 60_000;

/** An error's type and code, never its message: `TimeoutError`, gRPC `14`, `ECONNRESET`. */
export function errorKind(err: unknown): {
  type: string;
  code?: string | number;
} {
  if (!(err instanceof Error)) return { type: typeof err };
  const code = (err as { code?: unknown }).code;
  return {
    type: (err.name || 'Error').slice(0, 100),
    ...(typeof code === 'number' ||
    (typeof code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(code))
      ? { code }
      : {}),
  };
}

export interface TokenReaderOptions {
  /** The secret's name (`axiom-ingest-token`). */
  secret: string;
  read: (secretName: string) => Promise<string>;
  /** The warning's text before the reason: `Spans are not sent to Axiom`. */
  warning: string;
  retryMs?: number;
  now?: () => number;
}

/**
 * The token, once a read has succeeded; `undefined` while it can't be read. The first call reads;
 * after a failure, a call within `retryMs` resolves `undefined` at once, a later one reads again.
 * Concurrent calls share one read. Never rejects.
 */
export function tokenReader({
  secret,
  read,
  warning,
  retryMs = TOKEN_RETRY_MS,
  now = Date.now,
}: TokenReaderOptions): () => Promise<string | undefined> {
  let token: string | undefined;
  let reading: Promise<string | undefined> | undefined;
  let failedAt = -Infinity;
  let warned = false;

  const fail = (reason: string, fields: Record<string, unknown> = {}) => {
    failedAt = now();
    if (!warned) {
      warned = true;
      writeLog('WARNING', `${warning}: ${reason}; trying again once a minute`, {
        event: 'startup',
        ...fields,
      });
    }
    return undefined;
  };

  const attempt = async (): Promise<string | undefined> => {
    let value: string;
    try {
      value = (await read(secret)).trim();
    } catch (err) {
      return fail(`the token (${secret}) couldn't be read`, {
        error: errorKind(err),
      });
    }
    if (!value) return fail(`the token (${secret}) is empty`);
    token = value;
    return token;
  };

  return () => {
    if (token !== undefined) return Promise.resolve(token);
    if (reading) return reading;
    if (now() - failedAt < retryMs) return Promise.resolve(undefined);
    reading = attempt()
      .catch(() => undefined)
      .finally(() => {
        reading = undefined;
      });
    return reading;
  };
}
