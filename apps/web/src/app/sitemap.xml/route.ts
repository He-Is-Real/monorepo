import { indexingAllowed, siteUrl } from '@/lib/config';
import { StoriesUnavailableError } from '@/lib/public-stories';
import {
  renderSitemap,
  SitemapBudgetError,
  sharedStoryEntries,
} from '@/lib/sitemap';

// Per request: the switch is the deployment's (OpenTofu), and stories change.
export const dynamic = 'force-dynamic';

// D51: nothing that lists stories is cached, so a withdrawn story's URL doesn't linger here.
// Caching at Go live is the front door's question (D56).
const NO_STORE = { 'Cache-Control': 'no-store' };

/** Failures that mean "try again later": the API, the walk's budget, or an aborted walk. */
const retryable = (err: unknown) =>
  err instanceof StoriesUnavailableError ||
  err instanceof SitemapBudgetError ||
  (err instanceof DOMException &&
    (err.name === 'AbortError' || err.name === 'TimeoutError'));

/**
 * /sitemap.xml: only when indexing is allowed (Go live). Until then (always in dev) it doesn't
 * exist, so nothing invites a crawler in. While api-public-read is down, or the walk goes over
 * its budget: 503, never a sitemap missing its stories. Only the request's abort signal is
 * used (so a closed request can stop the walk); nothing is read from the request (D32).
 */
export async function GET(request: Request): Promise<Response> {
  const origin = siteUrl();
  if (!indexingAllowed() || !origin) {
    return new Response('Not found\n', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', ...NO_STORE },
    });
  }
  try {
    const stories = await sharedStoryEntries(request.signal);
    return new Response(renderSitemap(origin, stories), {
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        ...NO_STORE,
      },
    });
  } catch (err) {
    if (!retryable(err)) throw err;
    return new Response('Stories are unavailable; try again later.\n', {
      status: 503,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Retry-After': '300',
        ...NO_STORE,
      },
    });
  }
}
