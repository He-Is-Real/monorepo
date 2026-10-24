/**
 * @jest-environment node
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { browseStories, listTags, type StorySummary } from '@/lib/browse';
import { StoriesUnavailableError } from '@/lib/public-stories';
import BrowsePage, { generateMetadata } from './page';

jest.mock('next/server', () => ({
  connection: jest.fn(async () => undefined),
}));
jest.mock('next/navigation', () => ({
  usePathname: () => '/stories',
  useRouter: () => ({ push: jest.fn() }),
}));
jest.mock('next/form', () => ({
  __esModule: true,
  default: (props: React.FormHTMLAttributes<HTMLFormElement>) => (
    <form {...props} />
  ),
}));
jest.mock('./actions', () => ({ loadMoreStories: jest.fn() }));
jest.mock('@/lib/browse', () => ({
  ...jest.requireActual('@/lib/browse'),
  browseStories: jest.fn(),
  listTags: jest.fn(),
}));
const browse = browseStories as jest.Mock;
const tags = listTags as jest.Mock;

const TAGS = [
  { slug: 'healing', name: 'Healing', category: 'theme', version: 1 },
  { slug: 'loss', name: 'Loss', category: 'theme', version: 1 },
  { slug: 'faith', name: 'Faith', category: 'journey', version: 1 },
  { slug: 'hope', name: 'Hope', category: 'emotion', version: 1 },
];
const card = (n: number): StorySummary => ({
  id: `s${n}`,
  slug: `story-${n}`,
  title: `Story number ${n}`,
  excerpt: 'Dummy.',
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
const page = (from: number, nextCursor: string | null) => ({
  data: Array.from({ length: 15 }, (_, i) => card(from + i)),
  nextCursor,
});
const render = async (sp: Record<string, string | string[]> = {}) =>
  renderToStaticMarkup(await BrowsePage({ searchParams: Promise.resolve(sp) }));

describe('/stories (browse)', () => {
  beforeEach(() => {
    browse.mockReset();
    tags.mockReset().mockResolvedValue(TAGS);
  });

  it('server-renders the heading, labelled filters and the first page of cards', async () => {
    browse.mockResolvedValue(page(0, 'c1'));
    const html = await render();
    expect(html).toContain('God Stories</h1>');
    expect(html).toMatch(
      /<label[^>]*for="browse-q"[^>]*>Search stories<\/label>/,
    );
    expect(html).toContain('<option value="oldest">Oldest first</option>');
    expect(html).toContain('<option value="written">Written</option>');
    expect(html).not.toContain('Best match');
    expect(html).toContain('Story number 0');
    expect(html).toContain('Story number 14');
    expect(browse).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 15, sort: 'latest', tags: [] }),
    );
  });

  it('links each tag to the filtered list, and marks the selected ones', async () => {
    browse.mockResolvedValue(page(0, null));
    const html = await render({ tag: 'healing' });
    expect(html).toMatch(/href="\/stories"[^>]*>All</);
    expect(html).toContain('href="/stories?tag=healing&amp;tag=loss"');
    expect(html).toMatch(/>Healing<span class="sr-only"> \(selected\)<\/span>/);
    expect(html).toContain('Stories tagged Healing');
    // Journey and emotion tags sit behind "More tags".
    expect(html).toMatch(/<details[^>]*>.*More tags.*Faith.*Hope/s);
  });

  it('opens More tags when one of its tags is selected', async () => {
    browse.mockResolvedValue(page(0, null));
    expect(await render({ tag: 'hope' })).toMatch(/<details[^>]*open=""/);
  });

  it('never shows a count (api-conventions: no totals)', async () => {
    browse.mockResolvedValue(page(0, 'c1'));
    const html = await render({ q: 'hope' });
    expect(html).toContain('Results for “hope”');
    expect(html).toContain('Best match');
    expect(html).not.toMatch(/\d+ (of|stories)/);
  });

  it('rebuilds ?pages=3 from three pages', async () => {
    browse
      .mockResolvedValueOnce(page(0, 'c1'))
      .mockResolvedValueOnce(page(15, 'c2'))
      .mockResolvedValueOnce(page(30, 'c3'));
    const html = await render({ pages: '3' });
    expect(browse).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ cursor: 'c2' }),
    );
    expect(html).toContain('Story number 44');
    expect(html).toContain('Show more stories');
  });

  it('shows a calm empty state with a way back', async () => {
    browse.mockResolvedValue({ data: [], nextCursor: null });
    const html = await render({ tag: 'loss', format: 'audio' });
    expect(html).toContain('No stories match these filters yet.');
    expect(html).toMatch(/href="\/stories"[^>]*>Clear filters</);
  });

  it('says stories can’t load when the API is down, and still renders the page', async () => {
    browse.mockRejectedValue(new StoriesUnavailableError('status 503'));
    tags.mockRejectedValue(new StoriesUnavailableError('status 503'));
    const html = await render();
    expect(html).toContain('God Stories</h1>');
    expect(html).toContain('Stories can’t be loaded right now.');
  });

  it('has its own canonical and Open Graph card', async () => {
    // pageMetadata (lib/seo.ts) builds absolute URLs from SITE_URL, read per request.
    process.env['SITE_URL'] = 'https://example.org';
    const meta = await generateMetadata();
    delete process.env['SITE_URL'];
    expect(meta.title).toBe('God Stories');
    expect(meta.alternates?.canonical).toBe('https://example.org/stories');
  });
});
