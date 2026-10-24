import type { BrowseParams, BrowseSort, StoryFormat } from './browse';

// The browse page's state lives in its URL (`/stories?q=&tag=&format=&sort=&pages=`), so links,
// Back and reloads show the same stories (D55: "the position is kept in the URL"). Anything the
// API would refuse is dropped here rather than turned into an error page.

export interface BrowseFilters {
  q: string;
  /** A story must have all of them (the API's rule), at most 5. */
  tags: string[];
  format: StoryFormat | null;
  sort: BrowseSort;
}

/** Cards per page: D55's "about 45 stories" over the first page and 2 automatic ones. */
export const PAGE_SIZE = 15;
/** D55 (AGENTS.md): at most 2 extra pages load on their own, then a button. */
export const AUTO_LOADS = 2;
/** How many pages a URL may ask the server to rebuild (`?pages=`). */
export const MAX_PAGES = 10;

const Q_MAX_CHARS = 200;
const TAGS_MAX = 5;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FORMATS: readonly StoryFormat[] = ['video', 'audio', 'written'];
const SORTS: readonly BrowseSort[] = ['latest', 'oldest', 'relevance'];

type SearchParams = Record<string, string | string[] | undefined>;

const one = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : undefined;
const list = (v: unknown): unknown[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];

/** Filters from untrusted input (the URL, or what the browser sends the server action). */
export function sanitizeFilters(input: {
  q?: unknown;
  tags?: unknown;
  format?: unknown;
  sort?: unknown;
}): BrowseFilters {
  const q = [...(one(input.q)?.trim() ?? '')].slice(0, Q_MAX_CHARS).join('');
  const tags = [
    ...new Set(
      list(input.tags).filter(
        (t): t is string =>
          typeof t === 'string' && t.length <= 100 && SLUG.test(t),
      ),
    ),
  ].slice(0, TAGS_MAX);
  const format = one(input.format) as StoryFormat | undefined;
  const sort = one(input.sort) as BrowseSort | undefined;
  return {
    q,
    tags,
    format: format && FORMATS.includes(format) ? format : null,
    sort:
      sort && SORTS.includes(sort) && (sort !== 'relevance' || q)
        ? sort
        : q
          ? 'relevance'
          : 'latest',
  };
}

export function parseBrowseSearch(sp: SearchParams): {
  filters: BrowseFilters;
  pages: number;
} {
  const filters = sanitizeFilters({
    q: sp['q'],
    tags: sp['tag'],
    format: sp['format'],
    sort: sp['sort'],
  });
  const raw = one(sp['pages']);
  const n = raw && /^\d{1,3}$/.test(raw) ? Number(raw) : 1;
  return { filters, pages: Math.min(MAX_PAGES, Math.max(1, n)) };
}

/** The browse URL for these filters (defaults left out), optionally with a page count. */
export function browseHref(
  filters: BrowseFilters,
  extra: { pages?: number } = {},
): string {
  const sp = new URLSearchParams();
  if (filters.q) sp.set('q', filters.q);
  for (const t of filters.tags) sp.append('tag', t);
  if (filters.format) sp.set('format', filters.format);
  const defaultSort = filters.q ? 'relevance' : 'latest';
  if (filters.sort !== defaultSort) sp.set('sort', filters.sort);
  if (extra.pages && extra.pages > 1) sp.set('pages', String(extra.pages));
  return sp.size ? `/stories?${sp}` : '/stories';
}

export function toggleTag(filters: BrowseFilters, slug: string): BrowseFilters {
  const tags = filters.tags.includes(slug)
    ? filters.tags.filter((t) => t !== slug)
    : [...filters.tags, slug].slice(-TAGS_MAX);
  return { ...filters, tags };
}

/** Automatic loads still allowed after `pagesLoaded` pages (D55). */
export const autoLoadsLeft = (pagesLoaded: number) =>
  Math.max(0, AUTO_LOADS - (pagesLoaded - 1));

/** The API call for these filters (`lib/browse.ts`). */
export function toBrowseParams(
  filters: BrowseFilters,
  cursor?: string,
): BrowseParams {
  return {
    q: filters.q || undefined,
    tags: filters.tags,
    format: filters.format ?? undefined,
    sort: filters.sort,
    limit: PAGE_SIZE,
    ...(cursor ? { cursor } : {}),
  };
}
