import { browseStories, type BrowseParams, type StoryPage } from './browse';
import { STATIC_PAGES } from './site-pages';

// The sitemap (M1 1.7): the site's own pages and every published story, from api-public-read
// (D32: server-side, nothing from the visitor). Served only when indexing is allowed
// (app/sitemap.xml/route.ts).

/** The sitemaps.org limit for one file; beyond it we'd need a sitemap index. */
export const MAX_URLS = 50_000;
const PAGE_SIZE = 50;
/** A hard bound on API calls per sitemap: enough pages for MAX_URLS, never more. */
export const MAX_PAGES = Math.ceil(MAX_URLS / PAGE_SIZE);
/** The whole walk's budget, whatever each page's own 10 s timeout. */
export const DEADLINE_MS = 20_000;

export interface StoryEntry {
  slug: string;
  publishedAt: string;
}

/** The walk went over its budget (time, pages) or the API's cursors loop: answer 503. */
export class SitemapBudgetError extends Error {
  constructor(reason: string) {
    super(`sitemap budget exceeded: ${reason}`);
    this.name = 'SitemapBudgetError';
  }
}

type FetchPage = (
  params: BrowseParams,
  opts: { signal?: AbortSignal },
) => Promise<StoryPage>;

/**
 * Every published story, newest first, following the list's cursors. Stops at the protocol's
 * limit (together with the static pages) or at an empty page. Gives up, with no partial
 * sitemap, on any API failure, a repeated cursor, more than `maxPages` pages, the overall
 * deadline (which also aborts the page in flight) or the caller's signal.
 */
export async function collectStoryEntries(
  fetchPage: FetchPage = browseStories,
  {
    signal,
    maxPages = MAX_PAGES,
  }: { signal?: AbortSignal; maxPages?: number } = {},
): Promise<StoryEntry[]> {
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new SitemapBudgetError(`over ${DEADLINE_MS} ms`)),
    DEADLINE_MS,
  );
  const walk = signal
    ? AbortSignal.any([signal, deadline.signal])
    : deadline.signal;
  try {
    const room = MAX_URLS - STATIC_PAGES.length;
    const entries: StoryEntry[] = [];
    const seen = new Set<string>();
    let cursor: string | null | undefined;
    for (let pages = 0; ; pages++) {
      walk.throwIfAborted();
      if (pages === maxPages) {
        throw new SitemapBudgetError(`more than ${maxPages} pages`);
      }
      const page = await fetchPage(
        { sort: 'latest', limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) },
        { signal: walk },
      );
      for (const s of page.data) {
        if (entries.length === room) return entries;
        entries.push({ slug: s.slug, publishedAt: s.publishedAt });
      }
      cursor = page.nextCursor;
      if (!cursor || page.data.length === 0 || entries.length === room) {
        return entries;
      }
      if (seen.has(cursor)) throw new SitemapBudgetError('repeated cursor');
      seen.add(cursor);
    }
  } finally {
    clearTimeout(timer);
  }
}

interface Flight {
  promise: Promise<StoryEntry[]>;
  controller: AbortController;
  waiters: number;
}
let flight: Flight | undefined;

/** Resolves with `promise`, or rejects as soon as `signal` aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/**
 * The stories for a sitemap request. Concurrent requests share one walk (single flight); it's
 * dropped as soon as it settles, so nothing is kept between walks (D51: no stale story data).
 * A request that goes away stops waiting; when every waiting request has gone, the walk itself
 * is aborted, down to the API call in flight.
 */
export async function sharedStoryEntries(
  signal: AbortSignal,
  fetchPage: FetchPage = browseStories,
): Promise<StoryEntry[]> {
  signal.throwIfAborted();
  let current = flight;
  if (!current) {
    const controller = new AbortController();
    const created: Flight = {
      controller,
      waiters: 0,
      promise: collectStoryEntries(fetchPage, { signal: controller.signal }),
    };
    const clear = () => {
      if (flight === created) flight = undefined;
    };
    created.promise.then(clear, clear);
    flight = current = created;
  }
  current.waiters++;
  try {
    return await untilAborted(current.promise, signal);
  } finally {
    current.waiters--;
    if (current.waiters === 0 && signal.aborted) {
      if (flight === current) flight = undefined;
      current.controller.abort(signal.reason);
    }
  }
}

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};
const xml = (text: string) => text.replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);

/** `YYYY-MM-DD`, or undefined for anything that isn't a date. */
function day(iso: string): string | undefined {
  const time = Date.parse(iso);
  return Number.isNaN(time)
    ? undefined
    : new Date(time).toISOString().slice(0, 10);
}

export function renderSitemap(origin: string, stories: StoryEntry[]): string {
  const urls = [
    ...STATIC_PAGES.map(
      (p) =>
        `<url><loc>${xml(origin + p.path)}</loc><changefreq>${p.changeFrequency}</changefreq></url>`,
    ),
    ...stories.map((s) => {
      const lastmod = day(s.publishedAt);
      return `<url><loc>${xml(`${origin}/stories/${encodeURIComponent(s.slug)}`)}</loc>${
        lastmod ? `<lastmod>${lastmod}</lastmod>` : ''
      }</url>`;
    }),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}
