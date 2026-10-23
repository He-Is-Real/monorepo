import { apiPublicReadUrl } from './config';

/** How long the answer is reused across requests: a switch flip shows within a minute. */
const REVALIDATE_SECONDS = 60;
const TIMEOUT_MS = 3_000;

/**
 * D48: whether the database relaxes consent checks (dev only, for dummy data). Read from
 * api-public-read's `/health`, which reads the database's own switch, so the site can't
 * disagree with the consent checks themselves (no separate web setting). Server-side, with
 * nothing from the visitor (D32). Anything but a clear `true` is false: the note is
 * informational, and a missing note never weakens a check.
 */
export async function consentChecksRelaxed(): Promise<boolean> {
  try {
    const res = await fetch(`${apiPublicReadUrl()}/health`, {
      headers: { accept: 'application/json' },
      next: { revalidate: REVALIDATE_SECONDS },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { consentChecksRelaxed?: unknown };
    return body?.consentChecksRelaxed === true;
  } catch {
    return false;
  }
}
