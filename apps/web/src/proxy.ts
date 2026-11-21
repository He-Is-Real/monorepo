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
 *    limit gets exactly what a crash gives: the request is rewritten to a page that fails to
 *    render, so Next answers with status 500 and the site's error page (app/error.tsx), nothing
 *    that says it was a limit (RL-5). Only
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
    // Rendered by Next as a real crash, at the same URL (something-went-wrong/). Server
    // actions (the only POSTs our pages take) go to a route handler, which never runs one.
    const crash = request.nextUrl.clone();
    crash.pathname =
      request.method === 'POST' ? `${CRASH_PATH}/action` : CRASH_PATH;
    crash.search = '';
    return NextResponse.rewrite(crash, { headers });
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

function groupOf(pathname: string): RateLimitGroup | undefined {
  if (STATIC_PREFIX.test(pathname) || PUBLIC_FILES.has(pathname))
    return undefined;
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

/** The page that fails like any crash (RL-5). */
const CRASH_PATH = '/something-went-wrong';
