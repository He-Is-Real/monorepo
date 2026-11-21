import { type NextRequest, NextResponse } from 'next/server';
import {
  callerKey,
  RATE_LIMITS,
  type RateLimitGroup,
  rateLimitsActive,
  SlidingWindowCounter,
} from '@heisreal/http/rate-limits';
import { writeLog } from '@heisreal/logging';
import { robotsNoindex, serverNow } from '@/lib/config';
import { TRY_AGAIN_LATER } from '@/lib/try-again-later';
import { visitorAddress } from '@/lib/visitor-address';

/**
 * Two jobs, on every page and asset, including /health:
 *
 * 1. Dev is public but not a real site yet: unless indexing is explicitly allowed (INDEXING=allow
 *    and a site URL; OpenTofu refuses it in dev), every response tells search engines not to
 *    index or follow it (Next's own trailing-slash redirects run before the proxy; they point at
 *    pages that carry it). The layout's robots meta tag says the same for pages.
 *
 * 2. Rate limits (RL-8 A, Joel 2026-11-21): page loads and server actions (which arrive as POSTs
 *    to a page) are counted per visitor address, in this copy's memory, in a sliding window
 *    (groups and numbers: libs/http limits.ts). Static files aren't counted. A visitor over a
 *    limit gets the site's generic error, "Something went wrong. Please try again later.", with
 *    status 500 like any other server error, and nothing that says it was a limit (RL-5). Only
 *    the log says so, naming the group, never the address.
 *
 * The visitor's address (`visitorAddress`, D32's second carve-out) is the one thing read from
 * the request, for counting only. In the self-hosted Node server
 * Cloud Run runs, this file is loaded once per copy, so its counters last between requests;
 * they start again when a copy starts. Limits are on only where Cloud Run runs the site
 * (`K_SERVICE`, which Cloud Run sets itself), so local runs and the e2e servers never trip them;
 * one e2e server sets it to turn them on (e2e/rate-limits.e2e.ts). Their clock is `serverNow()`, pinned in
 * e2e.
 */
export function proxy(request: NextRequest) {
  const limited = rateLimited(request);
  const headers: Record<string, string> = robotsNoindex()
    ? { 'X-Robots-Tag': 'noindex, nofollow' }
    : {};
  if (limited) {
    return new NextResponse(GENERIC_ERROR_PAGE, {
      status: 500,
      headers: {
        ...headers,
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }
  return NextResponse.next({ headers });
}

export const config = {
  // Every page and asset, including /health.
  matcher: '/:path*',
};

const counters = new Map<RateLimitGroup, SlidingWindowCounter>();

function counter(group: RateLimitGroup): SlidingWindowCounter {
  let c = counters.get(group);
  if (!c) {
    c = new SlidingWindowCounter({
      windowMs: RATE_LIMITS[group].windowMs,
      now: serverNow,
    });
    counters.set(group, c);
  }
  return c;
}

/** Files Next serves as they are: not counted. */
const STATIC_FILE =
  /^\/_next\/(?:static|image)\/|\.(?:ico|png|jpe?g|webp|avif|gif|svg|woff2?|css|js|map)$/;

function groupOf(pathname: string): RateLimitGroup | undefined {
  if (STATIC_FILE.test(pathname)) return undefined;
  if (pathname === '/health') return 'health';
  if (pathname === '/sitemap.xml') return 'webSitemap';
  return 'webPages';
}

/** Counts the request; whether its visitor is over the limit. */
function rateLimited(request: NextRequest): boolean {
  if (!rateLimitsActive()) return false;
  const group = groupOf(request.nextUrl.pathname);
  if (!group) return false;
  const ip = visitorAddress(request);
  if (!ip) return false;
  const { limit } = RATE_LIMITS[group];
  const count = Math.ceil(counter(group).hit(callerKey(ip)));
  if (count <= limit) return false;
  // One line as a visitor first goes over, not one per refused request.
  if (count === limit + 1) {
    writeLog('WARNING', 'Rate limit reached', {
      event: 'rate_limited',
      group,
    });
  }
  return true;
}

/**
 * The site's generic error (Joel, 2026-11-09): the words of the error page (app/error.tsx),
 * served by the proxy itself, which can't render the site's pages.
 */
const [heading, ...rest] = TRY_AGAIN_LATER.split('. ');
const GENERIC_ERROR_PAGE = `<!doctype html>
<html lang="en-GB">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Something went wrong</title>
<style>:root{color-scheme:light dark}body{margin:0;font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center;padding:1rem}a{display:inline-flex;min-height:44px;align-items:center}</style>
</head>
<body><main id="main"><h1>${heading}</h1><p>${rest.join('. ')}</p><p><a href="/">Go to the home page</a></p></main></body>
</html>`;
