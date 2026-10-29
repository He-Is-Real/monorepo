import { apiPublicReadUrl } from './config';

// D32: a site video's player link comes from api-public-read, read on the server with nothing
// from the visitor's request, like a story's. The link is signed and expires (D52, 6–7 hours),
// so it's read per request and never cached.

/** `SiteVideoKey` in libs/contracts/openapi/components.yaml. */
export type SiteVideoKey = 'founder-intro' | 'next-steps';

/** A short wait: the page shows its placeholder rather than hang on a slow API. */
const TIMEOUT_MS = 5_000;

/**
 * The signed player link for a site video (`GET /v1/site-videos/{key}`), or `null` when there's
 * none: not set in this environment (404), or api-public-read is down or answers oddly. The page
 * then shows its placeholder; nothing here fails the page.
 */
export async function siteVideoUrl(key: SiteVideoKey): Promise<string | null> {
  try {
    const res = await fetch(`${apiPublicReadUrl()}/v1/site-videos/${key}`, {
      headers: { accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`status ${res.status}`);
    const body = (await res.json()) as { key?: unknown; playbackUrl?: unknown };
    if (body.key !== key || typeof body.playbackUrl !== 'string') {
      throw new Error('unexpected body');
    }
    return body.playbackUrl;
  } catch (err) {
    console.error(
      `api-public-read: site video ${key} unavailable: ${err instanceof Error ? err.message : 'error'}`,
    );
    return null;
  }
}
