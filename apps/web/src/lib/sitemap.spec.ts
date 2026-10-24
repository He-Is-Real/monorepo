/**
 * @jest-environment node
 */
import type { BrowseParams, StoryPage, StorySummary } from './browse';
import {
  collectStoryEntries,
  DEADLINE_MS,
  MAX_PAGES,
  MAX_URLS,
  renderSitemap,
  SitemapBudgetError,
  sharedStoryEntries,
} from './sitemap';
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

const pageOf = (slugs: string[], nextCursor: string | null): StoryPage => ({
  data: slugs.map(card),
  nextCursor,
});

/** A fetchPage that never answers until its signal aborts, then rejects with the reason. */
const hanging = () =>
  jest.fn(
    (_p: BrowseParams, { signal }: { signal?: AbortSignal }) =>
      new Promise<StoryPage>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason));
      }),
  );

describe('collectStoryEntries', () => {
  it('follows the cursors through every page, newest first, 50 at a time, passing its signal', async () => {
    const pages: Record<string, StoryPage> = {
      start: pageOf(['a', 'b'], 'c1'),
      c1: pageOf(['c'], 'c2'),
      c2: pageOf(['d'], null),
    };
    const fetchPage = jest.fn(
      async (p: BrowseParams) => pages[p.cursor ?? 'start'],
    );
    const entries = await collectStoryEntries(fetchPage);
    expect(entries.map((e) => e.slug)).toEqual(['a', 'b', 'c', 'd']);
    expect(fetchPage).toHaveBeenNthCalledWith(
      1,
      { sort: 'latest', limit: 50 },
      { signal: expect.any(AbortSignal) },
    );
    expect(fetchPage).toHaveBeenNthCalledWith(
      3,
      { sort: 'latest', limit: 50, cursor: 'c2' },
      { signal: expect.any(AbortSignal) },
    );
  });

  it('stops at the sitemap protocol’s 50,000 URLs', async () => {
    let n = 0;
    const fetchPage = jest.fn(async () =>
      pageOf(
        Array.from({ length: 50 }, () => `s${n}`).map((s, i) => `${s}-${i}`),
        `c${++n}`,
      ),
    );
    const entries = await collectStoryEntries(fetchPage);
    expect(entries).toHaveLength(MAX_URLS - STATIC_PAGES.length);
    expect(fetchPage).toHaveBeenCalledTimes(MAX_PAGES);
  });

  it('stops at an empty page even if the API offers another cursor', async () => {
    const fetchPage = jest
      .fn()
      .mockResolvedValueOnce(pageOf(['a'], 'c1'))
      .mockResolvedValueOnce(pageOf([], 'c2'));
    const entries = await collectStoryEntries(fetchPage);
    expect(entries.map((e) => e.slug)).toEqual(['a']);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('refuses a repeated cursor (a loop), with no partial sitemap', async () => {
    const fetchPage = jest
      .fn()
      .mockResolvedValueOnce(pageOf(['a'], 'c1'))
      .mockResolvedValueOnce(pageOf(['b'], 'c2'))
      .mockResolvedValueOnce(pageOf(['c'], 'c1'));
    await expect(collectStoryEntries(fetchPage)).rejects.toBeInstanceOf(
      SitemapBudgetError,
    );
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it('refuses more pages than the hard bound', async () => {
    let n = 0;
    const fetchPage = jest.fn(async () => pageOf([`s${n}`], `c${++n}`));
    await expect(
      collectStoryEntries(fetchPage, { maxPages: 3 }),
    ).rejects.toBeInstanceOf(SitemapBudgetError);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  describe('overall deadline', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('aborts the page in flight and gives up when the whole walk takes too long', async () => {
      const fetchPage = hanging();
      const pending = collectStoryEntries(fetchPage);
      const settled =
        expect(pending).rejects.toBeInstanceOf(SitemapBudgetError);
      await jest.advanceTimersByTimeAsync(DEADLINE_MS);
      await settled;
      expect(fetchPage.mock.calls[0][1].signal?.aborted).toBe(true);
    });
  });

  it('stops when the caller’s signal aborts', async () => {
    const controller = new AbortController();
    const fetchPage = hanging();
    const pending = collectStoryEntries(fetchPage, {
      signal: controller.signal,
    });
    controller.abort(new Error('gone'));
    await expect(pending).rejects.toThrow('gone');
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('passes the API’s failure on (no partial sitemap)', async () => {
    const fetchPage = jest
      .fn()
      .mockResolvedValueOnce(pageOf(['a'], 'c1'))
      .mockRejectedValueOnce(new Error('down'));
    await expect(collectStoryEntries(fetchPage)).rejects.toThrow('down');
  });
});

describe('sharedStoryEntries (single flight)', () => {
  const deferred = () => {
    let resolve!: (p: StoryPage) => void;
    const promise = new Promise<StoryPage>((r) => (resolve = r));
    return { promise, resolve };
  };

  it('lets concurrent requests share one walk of the catalogue', async () => {
    const first = deferred();
    const fetchPage = jest.fn(() => first.promise);
    const a = sharedStoryEntries(new AbortController().signal, fetchPage);
    const b = sharedStoryEntries(new AbortController().signal, fetchPage);
    first.resolve(pageOf(['a'], null));
    await expect(a).resolves.toEqual([
      { slug: 'a', publishedAt: '2026-10-21T20:00:00Z' },
    ]);
    await expect(b).resolves.toEqual(await a);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('keeps nothing once a walk is done: the next request asks the API again', async () => {
    const fetchPage = jest
      .fn()
      .mockResolvedValueOnce(pageOf(['a'], null))
      .mockResolvedValueOnce(pageOf(['b'], null));
    await sharedStoryEntries(new AbortController().signal, fetchPage);
    const again = await sharedStoryEntries(
      new AbortController().signal,
      fetchPage,
    );
    expect(again.map((e) => e.slug)).toEqual(['b']);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('a request that goes away doesn’t cancel the walk for the others', async () => {
    const first = deferred();
    const fetchPage = jest.fn(
      (_p: BrowseParams, _o: { signal?: AbortSignal }) => first.promise,
    );
    const leaving = new AbortController();
    const a = sharedStoryEntries(leaving.signal, fetchPage);
    const b = sharedStoryEntries(new AbortController().signal, fetchPage);
    leaving.abort(new Error('client gone'));
    await expect(a).rejects.toThrow('client gone');
    expect(fetchPage.mock.calls[0][1].signal?.aborted).toBe(false);
    first.resolve(pageOf(['a'], null));
    await expect(b).resolves.toHaveLength(1);
  });

  it('cancels the walk, through to fetch, when every request has gone away', async () => {
    const fetchPage = hanging();
    const one = new AbortController();
    const two = new AbortController();
    const a = sharedStoryEntries(one.signal, fetchPage);
    const b = sharedStoryEntries(two.signal, fetchPage);
    one.abort(new Error('gone'));
    two.abort(new Error('gone'));
    await expect(a).rejects.toThrow('gone');
    await expect(b).rejects.toThrow('gone');
    expect(fetchPage.mock.calls[0][1].signal?.aborted).toBe(true);
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
