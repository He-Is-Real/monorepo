import type { ReactNode } from 'react';
import { unstable_rethrow } from 'next/navigation';
import { connection } from 'next/server';
import { writeLog } from '@heisreal/logging';
import {
  PAGE_CACHE,
  type PageCacheEnvironment,
  type PageCachePath,
  type PageCacheTime,
} from '@/page-cache.config';

// Page caching (Joel, 2026-11-21): a saved copy of a public page's render, in this server's
// memory, for the time page-cache.config.ts gives its row in this environment. Next.js's own
// `'use cache'` with an inline `cacheLife` (Cache Components; no custom server or handler). Its
// built-in in-memory store, in production, treats an entry as missing once its `revalidate` time
// has passed: it never serves an old copy while refreshing, and never keeps one when the refresh
// fails (D51's problem). Bounded by `cacheMaxMemorySize` (next.config.js), least recently used
// first out.

/** Path prefixes that are never cached, whatever the config says: personal or staff pages. */
const NEVER_CACHED = [
  '/account',
  '/admin',
  '/moderation',
  '/share',
  '/consent',
  '/sign-in',
  // Single story pages: not asked for (decision doc); a withdrawn story must go at once (D51).
  '/stories/',
];

/** "Until the next release": a year, longer than any server copy lives (a deploy restarts it). */
const RELEASE_SECONDS = 365 * 24 * 60 * 60;

/** The longest time a row may give, in seconds (a day); anything longer is 'release'. */
const MAX_SECONDS = 24 * 60 * 60;

const neverCached = (path: string) =>
  NEVER_CACHED.some((prefix) =>
    // '/stories/' covers the pages under /stories, not /stories itself.
    prefix.endsWith('/')
      ? path.startsWith(prefix)
      : path === prefix || path.startsWith(`${prefix}/`),
  );

const validTime = (time: unknown): time is PageCacheTime =>
  time === 'off' ||
  time === 'release' ||
  (typeof time === 'number' &&
    Number.isInteger(time) &&
    time > 0 &&
    time <= MAX_SECONDS);

/**
 * Refuses a table that would cache a personal or staff page, or gives a time that isn't 'off',
 * 'release' or whole seconds from 1 to a day. Checked when the server first loads this module, and
 * by the unit test against the committed file.
 */
export function checkPageCacheTable(
  table: Record<string, Record<string, unknown>>,
): void {
  for (const [path, row] of Object.entries(table)) {
    if (!path.startsWith('/'))
      throw new Error(`page cache: "${path}" is not a path`);
    if (neverCached(path))
      throw new Error(`page cache: ${path} must never be cached`);
    for (const env of ['dev', 'prod'] satisfies PageCacheEnvironment[]) {
      if (!validTime(row[env]))
        throw new Error(
          `page cache: ${path} needs a ${env} time ('off', 'release' or 1 to ${MAX_SECONDS} seconds)`,
        );
    }
  }
}

checkPageCacheTable(PAGE_CACHE);

/**
 * This deployment's column (`SITE_ENVIRONMENT`, set by OpenTofu from the environment's name).
 * Unset or unknown: nothing is cached (logged when it's set but unknown).
 */
export function pageCacheEnvironment(): PageCacheEnvironment | undefined {
  const env = process.env['SITE_ENVIRONMENT']?.trim();
  if (env === 'dev' || env === 'prod') return env;
  if (env)
    writeLog('ERROR', 'SITE_ENVIRONMENT is not dev or prod; no page is cached');
  return undefined;
}

/**
 * e2e only (`E2E_FIXTURES=true`; OpenTofu never sets it): `E2E_PAGE_CACHE`, a JSON object of a
 * listed path to seconds, replaces that row's time, so the tests can see a copy kept and a copy
 * expire without waiting 30 seconds. It can't add a path or cache a never-cached one.
 */
function e2eTime(path: PageCachePath): number | undefined {
  if (process.env['E2E_FIXTURES'] !== 'true') return undefined;
  const raw = process.env['E2E_PAGE_CACHE'];
  if (!raw) return undefined;
  const times = JSON.parse(raw) as Record<string, unknown>;
  const time = times[path];
  if (time === undefined) return undefined;
  if (!validTime(time) || typeof time !== 'number')
    throw new Error(`E2E_PAGE_CACHE: ${path} needs whole seconds`);
  return time;
}

export interface PageCacheLife {
  stale: number;
  revalidate: number;
  expire: number;
}

/** The `cacheLife` for a page here, or null when it isn't cached. */
export function pageCacheLife(path: PageCachePath): PageCacheLife | null {
  if (neverCached(path)) return null;
  const env = pageCacheEnvironment();
  if (!env) return null;
  const time: PageCacheTime = e2eTime(path) ?? PAGE_CACHE[path][env];
  if (time === 'off') return null;
  const seconds = time === 'release' ? RELEASE_SECONDS : time;
  return {
    // The browser's own router may reuse a page it has for this long (Next's minimum is 30 s).
    stale: Math.min(seconds, 5 * 60),
    // The server's copy: dropped once this has passed (the hard bound above).
    revalidate: seconds,
    // Next requires it to be longer than `revalidate`; the in-memory store has already dropped
    // the copy by then, so it never extends what's served.
    expire: seconds + 1,
  };
}

/**
 * A page served from its saved copy while there is one, else rendered and saved.
 *
 * `cached` is the page's own `'use cache'` function, which calls `cacheLife(life)`; `fresh`
 * renders the same page without saving it. Always per request (`connection()`): never rendered at
 * build time, so a copy never holds the build's settings (the root layout's reason too).
 *
 * A render that fails inside `cached` (e.g. a story page's API is down, which it signals by
 * throwing) is never saved: the page is then rendered fresh, which shows "try again later" the
 * usual way. Next's own signals (not found, redirect) pass straight through.
 */
export async function cachedPage(
  path: PageCachePath,
  cached: (life: PageCacheLife) => Promise<ReactNode>,
  fresh: () => ReactNode | Promise<ReactNode>,
): Promise<ReactNode> {
  await connection();
  const life = pageCacheLife(path);
  if (!life) return fresh();
  try {
    return await cached(life);
  } catch (err) {
    unstable_rethrow(err);
    return fresh();
  }
}
