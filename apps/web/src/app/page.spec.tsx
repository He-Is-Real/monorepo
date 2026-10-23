/**
 * @jest-environment node
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { browseStories, listTags, type StorySummary } from '@/lib/browse';
import { StoriesUnavailableError } from '@/lib/public-stories';
import Page, { generateMetadata } from './page';

jest.mock('next/server', () => ({
  connection: jest.fn(async () => undefined),
}));
jest.mock('@/components/logo', () => ({ Logo: () => <span>logo</span> }));
jest.mock('@/lib/browse', () => ({
  ...jest.requireActual('@/lib/browse'),
  browseStories: jest.fn(),
  listTags: jest.fn(),
}));
const browse = browseStories as jest.Mock;
const tags = listTags as jest.Mock;

const card = (n: number, slug = `newest-${n}`): StorySummary => ({
  id: `s${n}`,
  slug,
  title: `Newest ${n}`,
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
const TAGS = [
  { slug: 'healing', name: 'Healing', category: 'theme', version: 1 },
  { slug: 'salvation', name: 'Salvation', category: 'journey', version: 1 },
  { slug: 'joy', name: 'Joy', category: 'emotion', version: 1 },
];

describe('Home page (plan 1.1)', () => {
  beforeEach(() => {
    browse.mockReset().mockResolvedValue({
      data: [card(1), card(2), card(3)],
      nextCursor: 'c',
    });
    tags.mockReset().mockResolvedValue(TAGS);
  });

  it('opens with the question and the two ways in', async () => {
    const html = renderToStaticMarkup(await Page());
    expect(html).toContain('<main id="main"');
    expect(html.replace(/<[^>]+>/g, '')).toContain(
      'Is God Real?Does God exist?',
    );
    expect(html).toMatch(/href="\/stories"[^>]*>Browse stories</);
    expect(html).toMatch(/href="\/get-ready"[^>]*>Share your story</);
  });

  it('shows the three newest stories, never a chosen one (Joel, 2026-10-23)', async () => {
    const html = renderToStaticMarkup(await Page());
    expect(browse).toHaveBeenCalledTimes(1);
    expect(browse).toHaveBeenCalledWith({ limit: 3 });
    const titles = [...html.matchAll(/<h3[^>]*><a[^>]*>([^<]+)<\/a>/g)].map(
      (m) => m[1],
    );
    expect(titles).toEqual(['Newest 1', 'Newest 2', 'Newest 3']);
    expect(html).toContain('Recently shared</h2>');
    expect(html).not.toMatch(/featured/i);
    expect(html).toMatch(/href="\/stories"[^>]*>View all stories</);
  });

  it('links theme and faith-journey tags to browse', async () => {
    const html = renderToStaticMarkup(await Page());
    expect(html).toContain('Going through something?');
    expect(html).toMatch(/href="\/stories\?tag=healing"[^>]*>.*Healing/s);
    expect(html).toContain('Curious about faith?');
    expect(html).toMatch(/href="\/stories\?tag=salvation"/);
    expect(html).not.toContain('tag=joy');
  });

  it('marks the impact figures as placeholders and links giving to the placeholder page', async () => {
    const html = renderToStaticMarkup(await Page());
    expect(html).toContain('Placeholder figures');
    expect(html).toMatch(/href="\/donate"[^>]*>Give once</);
    expect(html).toMatch(/href="\/donate"[^>]*>Give monthly</);
  });

  it('keeps the page when the API is down', async () => {
    browse.mockRejectedValue(new StoriesUnavailableError('x'));
    tags.mockRejectedValue(new StoriesUnavailableError('x'));
    const html = renderToStaticMarkup(await Page());
    expect(html.replace(/<[^>]+>/g, '')).toContain('Does God exist?');
    expect(html).toContain('Stories can’t be loaded right now.');
  });

  it('has its own title and canonical', async () => {
    // pageMetadata (lib/seo.ts) builds absolute URLs from SITE_URL, read per request.
    process.env['SITE_URL'] = 'https://example.org';
    const meta = await generateMetadata();
    delete process.env['SITE_URL'];
    expect(meta.title).toEqual({
      absolute:
        'He Is Real Today: Is God real? Does God exist? Real stories from real people.',
    });
    expect(meta.alternates?.canonical).toBe('https://example.org/');
  });
});
