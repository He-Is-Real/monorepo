// SurrealDB runs on Spot (Joel, 2026-11-07): while Google restarts the database, the APIs answer
// `503 service_restarting` with `retryAfterSeconds` (components.yaml, `ServiceRestarting`). Web
// says "Our compute is currently restarting. Please try again in about N minutes", counted down in
// the browser, then "Please try again later." once the estimate has run out (Joel, 2026-11-09;
// docs/how-the-app-works.md, "When the database restarts"). Shared by web's server and the
// browser.

/** When an answer says it's restarting but gives no usable estimate: the APIs' default. */
export const RESTART_DEFAULT_SECONDS = 120;

/**
 * The seconds to wait if `res` is a `503 service_restarting`, else undefined. Reads the body, so
 * call it only on an answer that isn't otherwise used.
 */
export async function restartingSecondsOf(
  res: Response,
): Promise<number | undefined> {
  if (res.status !== 503) return undefined;
  const body = (await res.json().catch(() => undefined)) as
    { code?: unknown; retryAfterSeconds?: unknown } | undefined;
  if (body?.code !== 'service_restarting') return undefined;
  // The body's `retryAfterSeconds` (D32: web's server reads no headers outside api-user.ts).
  return restartingSeconds(body.retryAfterSeconds);
}

/**
 * The problem's `retryAfterSeconds`, else `Retry-After`, else the default, in whole seconds. The
 * APIs never suggest less than a minute (their floor); web adds none of its own.
 */
export function restartingSeconds(
  retryAfterSeconds: unknown,
  retryAfterHeader?: string | null,
): number {
  const fromHeader = retryAfterHeader ? Number(retryAfterHeader) : NaN;
  const seconds =
    typeof retryAfterSeconds === 'number' && Number.isFinite(retryAfterSeconds)
      ? retryAfterSeconds
      : Number.isFinite(fromHeader)
        ? fromHeader
        : RESTART_DEFAULT_SECONDS;
  return Math.max(0, Math.ceil(seconds));
}

/**
 * "Please try again in about 2 minutes." while the estimate runs (whole minutes left, rounded
 * up), then "Please try again later." once it has run out (Joel, 2026-11-09).
 */
export function tryAgainIn(secondsLeft: number): string {
  if (secondsLeft <= 0) return 'Please try again later.';
  const minutes = Math.ceil(secondsLeft / 60);
  return `Please try again in about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
}
