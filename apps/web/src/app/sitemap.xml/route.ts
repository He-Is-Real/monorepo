import { indexingAllowed, siteUrl } from '@/lib/config';
import { StoriesUnavailableError } from '@/lib/public-stories';
import { collectStoryEntries, renderSitemap } from '@/lib/sitemap';

// Per request: the switch is the deployment's (OpenTofu), and stories change.
export const dynamic = 'force-dynamic';

// D51: nothing that lists stories is cached, so a withdrawn story's URL doesn't linger here.
// Caching at Go live is the front door's question (D56).
const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * /sitemap.xml: only when indexing is allowed (Go live). Until then (always in dev) it doesn't
 * exist, so nothing invites a crawler in. While api-public-read is down: 503, never a sitemap
 * missing its stories.
 */
export async function GET(): Promise<Response> {
  const origin = siteUrl();
  if (!indexingAllowed() || !origin) {
    return new Response('Not found\n', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', ...NO_STORE },
    });
  }
  try {
    const stories = await collectStoryEntries();
    return new Response(renderSitemap(origin, stories), {
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        ...NO_STORE,
      },
    });
  } catch (err) {
    if (!(err instanceof StoriesUnavailableError)) throw err;
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
