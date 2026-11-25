import { type NextRequest, NextResponse } from 'next/server';
import {
  callerKey,
  RATE_LIMITS,
  type RateLimitGroup,
  rateLimitsActive,
  SlidingWindowCounter,
} from '@heisreal/http/rate-limits';
import { type WideEvent, writeSearchEvent } from '@heisreal/logging/event';
import { parseBrowseSearch } from '@/lib/browse-query';
import { robotsNoindex, serverNow } from '@/lib/config';
import {
  cacheFields,
  clientFields,
  startRequestEvent,
  WEB_SERVICE,
} from '@/lib/request-event';
import {
  isPrefetch,
  requestTraceparent,
  visitorAddress,
  visitorUserAgent,
} from '@/lib/visitor-address';

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
 *    limit gets exactly what a crash gives: the request is rewritten to a page that fails to
 *    render, so Next answers as for any crash (its status and the site's error page, app/error.tsx), nothing
 *    that says it was a limit (RL-5). Only
 *    the log says so, naming the group, never the address.
 *
 * 3. The request's wide event (writing-logs skill; LG-2 C, LG-4 A, Joel 22–24 Nov 2026), written
 *    here once the proxy has decided: the path (never the query), the visitor's address and
 *    browser (plain, LG-2), the page's cache policy, the rate-limit decision and the proxy's own
 *    time. Next runs the proxy before the page and gives it no end-of-response hook (its `after`
 *    runs when the proxy's own answer is done), so the page's status and full time are on Cloud
 *    Run's request line, which shares the `ref`'s trace; a server error is the error line
 *    `onRequestError` writes with the same `ref` (instrumentation.ts). A search (`/stories` with
 *    words or themes) also writes its own search event here, the one place that sees every
 *    search with the visitor's address (LG-2g A): who searched only as search-key hashes, and no
 *    `ref`. api-public-read writes none for web's own calls.
 *
 * The request headers read (`visitorAddress` and the rest, D32's second carve-out) are the
 * visitor's address, browser, trace and whether Next is prefetching. In the self-hosted Node server
 * Cloud Run runs, this file is loaded once per copy, so its counters last between requests;
 * they start again when a copy starts. Limits are on only where Cloud Run runs the site
 * (`K_SERVICE`, which Cloud Run sets itself), so local runs and the e2e servers never trip them;
 * one e2e server sets it to turn them on (e2e/rate-limits.e2e.ts). Their clock is `serverNow()`, pinned in
 * e2e.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  // Next's build output and our public files: no event (Cloud Run's request line has them).
  if (isStaticFile(pathname))
    return NextResponse.next({ headers: robotsHeaders() });
  const event = startRequestEvent(requestTraceparent(request));
  const ip = visitorAddress(request);
  const userAgent = visitorUserAgent(request);
  try {
    event.set({
      http: { method: request.method, path: pathname },
      client: clientFields(ip, userAgent),
      cache: cacheFields(pathname),
    });
    const limited = rateLimited(request, ip, event);
    const headers = robotsHeaders();
    if (limited) {
      // Rendered by Next as a real crash, at the same URL (something-went-wrong/). Server
      // actions (the only POSTs our pages take) go to a route handler, which never runs one.
      const crash = request.nextUrl.clone();
      crash.pathname =
        request.method === 'POST' ? `${CRASH_PATH}/action` : CRASH_PATH;
      crash.search = '';
      return NextResponse.rewrite(crash, { headers });
    }
    searchOf(request, ip, userAgent, event);
    return NextResponse.next({ headers });
  } finally {
    const ms = event.elapsedMs();
    event.set({ http: { proxy_ms: ms } });
    event.message(
      `${request.method} page ${event.outcome ?? 'ok'} in ${ms} ms (proxy)`,
    );
    // Its span (LG-15) sits under Next's own request span, which names the route.
    event.spanName(`proxy ${request.method}`);
    event.write();
  }
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

/**
 * Files Next serves as they are, not counted: its build output and our own public files, named
 * exactly (a file-like ending on any other path is still counted, so `/stories/x.png` can't skip
 * the count).
 */
const STATIC_PREFIX = /^\/_next\/(?:static|image)\//;
const PUBLIC_FILES = new Set([
  '/favicon.ico',
  '/logo.png',
  '/og-default.png',
  '/hero-backdrop.webp',
]);

const isStaticFile = (pathname: string) =>
  STATIC_PREFIX.test(pathname) || PUBLIC_FILES.has(pathname);

/** Tells search engines not to index dev (see above). */
const robotsHeaders = (): Record<string, string> =>
  robotsNoindex() ? { 'X-Robots-Tag': 'noindex, nofollow' } : {};

function groupOf(pathname: string): RateLimitGroup | undefined {
  if (isStaticFile(pathname)) return undefined;
  if (pathname === '/health') return 'health';
  if (pathname === '/sitemap.xml') return 'webSitemap';
  return 'webPages';
}

/**
 * Counts the request; whether its visitor is over the limit. The decision goes on the request's
 * event (`rate_limit.group`, `decision`), and a refusal sets `outcome: "rate_limited"`.
 */
function rateLimited(
  request: NextRequest,
  ip: string | undefined,
  event: WideEvent,
): boolean {
  if (!rateLimitsActive()) return false;
  const group = groupOf(request.nextUrl.pathname);
  if (!group || !ip) return false;
  const { limit } = RATE_LIMITS[group];
  const count = Math.ceil(counter(group).hit(callerKey(ip)));
  const refused = count > limit;
  event.set({
    rate_limit: { group, decision: refused ? 'refused' : 'allowed' },
  });
  if (refused) event.setOutcome('rate_limited', { force: true });
  return refused;
}

/**
 * The search event (LG-2g A) for a search a visitor made: a page load of `/stories` with words or
 * themes, not Next prefetching it. The terms and filters plain; who searched only as search-key
 * hashes; no `ref`. The number of results and the page's time aren't known here
 * (`http.duration_ms` is the proxy's).
 */
function searchOf(
  request: NextRequest,
  ip: string | undefined,
  userAgent: string | undefined,
  event: WideEvent,
): void {
  if (request.method !== 'GET' || isPrefetch(request)) return;
  const pathname = request.nextUrl.pathname.replace(/\/+$/, '');
  if (pathname !== '/stories') return;
  const params: Record<string, string | string[]> = {};
  for (const key of new Set(request.nextUrl.searchParams.keys())) {
    const all = request.nextUrl.searchParams.getAll(key);
    params[key] = all.length === 1 ? all[0] : all;
  }
  const { filters } = parseBrowseSearch(params);
  if (!filters.q && !filters.themes.length) return;
  writeSearchEvent({
    service: WEB_SERVICE,
    route: '/stories',
    durationMs: event.elapsedMs(),
    outcome: event.outcome ?? 'ok',
    search: {
      q: filters.q || undefined,
      tags: filters.themes.length ? filters.themes : undefined,
      filters: { format: filters.format ?? undefined, sort: filters.sort },
    },
    who: { ip, userAgent },
  });
}

/** The page that fails like any crash (RL-5). */
const CRASH_PATH = '/something-went-wrong';
