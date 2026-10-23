/**
 * @jest-environment node
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { browseStories, listTags, type StorySummary } from '@/lib/browse';
import { getPublicStory, StoriesUnavailableError } from '@/lib/public-stories';
import Page, { generateMetadata } from './page';

jest.mock('next/server', () => ({
  connection: jest.fn(async () => undefined),
}));
jest.mock('@/components/logo', () => ({ Logo: () => <span>logo</span> }));
jest.mock('@/lib/public-stories', () => ({
  ...jest.requireActual('@/lib/public-stories'),
  getPublicStory: jest.fn(),
}));
jest.mock('@/lib/browse', () => ({
  ...jest.requireActual('@/lib/browse'),
  browseStories: jest.fn(),
  listTags: jest.fn(),
}));
const getStory = getPublicStory as jest.Mock;
const browse = browseStories as jest.Mock;
const tags = listTags as jest.Mock;

const featured = {
  id: 'dev_seed',
  slug: 'featured-story',
  title: 'The featured story',
  description: 'Placeholder content.',
  body: 'Text.',
  bylineName: 'Test Person',
  primaryFormat: 'written',
  media: [],
  image: null,
  tags: [],
  publishedAt: '2026-10-21T20:00:00Z',
  version: 1,
};
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
  const saved = process.env['FEATURED_STORY_SLUG'];
  beforeEach(() => {
    getStory.mockReset();
    browse.mockReset().mockResolvedValue({
      data: [card(1, 'featured-story'), card(2), card(3), card(4)],
      nextCursor: 'c',
    });
    tags.mockReset().mockResolvedValue(TAGS);
  });
  afterEach(() => {
    if (saved === undefined) delete process.env['FEATURED_STORY_SLUG'];
    else process.env['FEATURED_STORY_SLUG'] = saved;
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

  it('features the FEATURED_STORY_SLUG story first, then the newest, three in all', async () => {
    process.env['FEATURED_STORY_SLUG'] = 'featured-story';
    getStory.mockResolvedValue({ kind: 'story', story: featured });
    const html = renderToStaticMarkup(await Page());
    expect(getStory).toHaveBeenCalledWith('featured-story');
    const titles = [...html.matchAll(/<h3[^>]*><a[^>]*>([^<]+)<\/a>/g)].map(
      (m) => m[1],
    );
    expect(titles).toEqual(['The featured story', 'Newest 2', 'Newest 3']);
    expect(html).toMatch(/href="\/stories"[^>]*>View all stories</);
  });

  it('shows the three newest without a featured story', async () => {
    delete process.env['FEATURED_STORY_SLUG'];
    const html = renderToStaticMarkup(await Page());
    expect(getStory).not.toHaveBeenCalled();
    expect(html).toContain('Newest 1');
    expect(html).not.toContain('Newest 4');
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
    process.env['FEATURED_STORY_SLUG'] = 'featured-story';
    getStory.mockRejectedValue(new StoriesUnavailableError('x'));
    browse.mockRejectedValue(new StoriesUnavailableError('x'));
    tags.mockRejectedValue(new StoriesUnavailableError('x'));
    const html = renderToStaticMarkup(await Page());
    expect(html.replace(/<[^>]+>/g, '')).toContain('Does God exist?');
    expect(html).toContain('Stories can’t be loaded right now.');
  });

  it('has its own title and canonical', async () => {
    const meta = await generateMetadata();
    expect(meta.title).toEqual({
      absolute:
        'He Is Real Today: Is God real? Does God exist? Real stories from real people.',
    });
    expect(meta.alternates?.canonical).toBe('/');
  });
});
