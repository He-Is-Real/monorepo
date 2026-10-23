import { browseStories, type BrowseParams, type StoryPage } from './browse';
import { STATIC_PAGES } from './site-pages';

// The sitemap (M1 1.7): the site's own pages and every published story, from api-public-read
// (D32: server-side, nothing from the visitor). Served only when indexing is allowed
// (app/sitemap.xml/route.ts).

/** The sitemaps.org limit for one file; beyond it we'd need a sitemap index. */
export const MAX_URLS = 50_000;
const PAGE_SIZE = 50;

export interface StoryEntry {
  slug: string;
  publishedAt: string;
}

/**
 * Every published story, newest first, following the list's cursors. Stops at the protocol's
 * limit (together with the static pages) however many pages the API offers. Any failure is
 * passed on: a partial sitemap would quietly drop stories.
 */
export async function collectStoryEntries(
  fetchPage: (params: BrowseParams) => Promise<StoryPage> = browseStories,
): Promise<StoryEntry[]> {
  const room = MAX_URLS - STATIC_PAGES.length;
  const entries: StoryEntry[] = [];
  let cursor: string | null | undefined;
  do {
    const page = await fetchPage({
      sort: 'latest',
      limit: PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    for (const s of page.data) {
      if (entries.length === room) return entries;
      entries.push({ slug: s.slug, publishedAt: s.publishedAt });
    }
    cursor = page.nextCursor;
  } while (cursor && entries.length < room);
  return entries;
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
