// SurrealDB runs on Spot (Joel, 2026-11-07): while Google restarts the database, the APIs answer
// `503 service_restarting` with `retryAfterSeconds` (components.yaml, `ServiceRestarting`). Web
// says "Our compute is currently restarting. Please refresh the page in about N minutes", counted
// down in the browser and never below "about 1 minute" (docs/how-the-app-works.md, "Database
// restarts"). Shared by web's server and the browser.

/** When an answer says it's restarting but gives no usable estimate: the APIs' default. */
export const RESTART_DEFAULT_SECONDS = 120;
/** The APIs never suggest less (their floor), and neither do we. */
export const RESTART_MIN_SECONDS = 60;

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

/** The problem's `retryAfterSeconds`, else `Retry-After`, else the default; at least a minute. */
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
  return Math.max(RESTART_MIN_SECONDS, Math.ceil(seconds));
}

/** "about 2 minutes", "about 1 minute": whole minutes left, rounded up, never under one. */
export function aboutMinutes(secondsLeft: number): string {
  const minutes = Math.max(1, Math.ceil(secondsLeft / 60));
  return minutes === 1 ? 'about 1 minute' : `about ${minutes} minutes`;
}
