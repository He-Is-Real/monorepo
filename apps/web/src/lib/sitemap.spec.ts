/**
 * @jest-environment node
 */
import type { StoryPage, StorySummary } from './browse';
import { collectStoryEntries, MAX_URLS, renderSitemap } from './sitemap';
import { STATIC_PAGES } from './site-pages';

const card = (slug: string): StorySummary => ({
  id: slug,
  slug,
  title: slug,
  excerpt: '',
  bylineName: null,
  primaryFormat: 'written',
  durationSeconds: null,
  thumbnailUrl: null,
  thumbnailWidth: null,
  thumbnailHeight: null,
  image: null,
  textLength: 300,
  tags: [],
  publishedAt: '2026-10-21T20:00:00Z',
});

describe('collectStoryEntries', () => {
  it('follows the cursors through every page, newest first, 50 at a time', async () => {
    const pages: Record<string, StoryPage> = {
      start: { data: [card('a'), card('b')], nextCursor: 'c1' },
      c1: { data: [card('c')], nextCursor: 'c2' },
      c2: { data: [card('d')], nextCursor: null },
    };
    const fetchPage = jest.fn(
      async (p: { cursor?: string }) => pages[p.cursor ?? 'start'],
    );
    const entries = await collectStoryEntries(fetchPage);
    expect(entries.map((e) => e.slug)).toEqual(['a', 'b', 'c', 'd']);
    expect(fetchPage).toHaveBeenNthCalledWith(1, { sort: 'latest', limit: 50 });
    expect(fetchPage).toHaveBeenNthCalledWith(3, {
      sort: 'latest',
      limit: 50,
      cursor: 'c2',
    });
  });

  it('stops at the sitemap protocol’s 50,000 URLs even if the cursor never ends', async () => {
    let n = 0;
    const fetchPage = jest.fn(async () => ({
      data: Array.from({ length: 50 }, () => card(`s${n++}`)),
      nextCursor: 'again',
    }));
    const entries = await collectStoryEntries(fetchPage);
    expect(entries).toHaveLength(MAX_URLS - STATIC_PAGES.length);
    expect(fetchPage.mock.calls.length).toBeLessThanOrEqual(
      Math.ceil(MAX_URLS / 50),
    );
  });

  it('passes the API’s failure on (no partial sitemap)', async () => {
    const fetchPage = jest
      .fn()
      .mockResolvedValueOnce({ data: [card('a')], nextCursor: 'c1' })
      .mockRejectedValueOnce(new Error('down'));
    await expect(collectStoryEntries(fetchPage)).rejects.toThrow('down');
  });
});

describe('renderSitemap', () => {
  const xml = renderSitemap('https://www.heisreal.today', [
    { slug: 'a-story', publishedAt: '2026-10-21T20:00:00Z' },
  ]);

  it('is a sitemaps.org urlset with absolute URLs for the pages and stories', () => {
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(
      true,
    );
    expect(xml).toContain(
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    );
    expect(xml).toContain(
      '<url><loc>https://www.heisreal.today/</loc><changefreq>weekly</changefreq></url>',
    );
    expect(xml).toContain(
      '<url><loc>https://www.heisreal.today/about</loc><changefreq>monthly</changefreq></url>',
    );
    expect(xml).toContain(
      '<url><loc>https://www.heisreal.today/stories/a-story</loc><lastmod>2026-10-21</lastmod></url>',
    );
    expect(xml.match(/<url>/g)).toHaveLength(STATIC_PAGES.length + 1);
  });

  it('escapes XML and URL-encodes slugs', () => {
    const out = renderSitemap('https://x.test', [
      { slug: `a&b<c>"d'`, publishedAt: 'not a date' },
    ]);
    expect(out).toContain(
      '<url><loc>https://x.test/stories/a%26b%3Cc%3E%22d&apos;</loc></url>',
    );
    expect(out).not.toContain('<lastmod>not');
  });
});
