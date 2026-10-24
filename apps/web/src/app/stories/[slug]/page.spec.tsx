/**
 * @jest-environment node
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { notFound, permanentRedirect } from 'next/navigation';
import StoryPage, { generateMetadata } from './page';
import { getRelatedStories } from '@/lib/browse';
import { getPublicStory, StoriesUnavailableError } from '@/lib/public-stories';

jest.mock('next/navigation', () => ({
  notFound: jest.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  permanentRedirect: jest.fn((to: string) => {
    throw new Error(`REDIRECT ${to}`);
  }),
}));
jest.mock('@/lib/public-stories', () => {
  const actual = jest.requireActual('@/lib/public-stories');
  return { ...actual, getPublicStory: jest.fn() };
});
const mockGet = getPublicStory as jest.Mock;
jest.mock('@/lib/browse', () => ({
  ...jest.requireActual('@/lib/browse'),
  getRelatedStories: jest.fn(),
}));
const mockRelated = getRelatedStories as jest.Mock;
const relatedCard = {
  id: 'r1',
  slug: 'related-one',
  title: 'A related story',
  excerpt: 'Dummy.',
  bylineName: null,
  primaryFormat: 'audio',
  durationSeconds: 65,
  thumbnailUrl: null,
  thumbnailWidth: null,
  thumbnailHeight: null,
  image: null,
  textLength: 0,
  tags: [{ slug: 'doubt', name: 'Doubt', category: 'journey', version: 1 }],
  publishedAt: '2026-10-20T20:00:00Z',
};

const story = {
  id: 'dev_seed',
  slug: 'test-story',
  title: 'Test story',
  description: 'Placeholder',
  body: 'Text.',
  bylineName: null,
  primaryFormat: 'written',
  tags: [{ slug: 'doubt', name: 'Doubt' }],
  publishedAt: '2026-10-21T20:00:00Z',
  version: 1,
};
const params = (slug: string) => ({ params: Promise.resolve({ slug }) });

describe('/stories/[slug]', () => {
  beforeEach(() =>
    mockRelated.mockResolvedValue({ kind: 'stories', stories: [relatedCard] }),
  );
  afterEach(() => jest.clearAllMocks());

  it('renders the story server-side, anonymous byline and tags included', async () => {
    mockGet.mockResolvedValue({ kind: 'story', story });
    const html = renderToStaticMarkup(await StoryPage(params('test-story')));
    expect(html).toContain('Test story</h1>');
    expect(html).toContain('Anonymous');
    expect(html).toContain('aria-label="Tags"');
    expect(html).toMatch(/href="\/stories\?tag=doubt"[^>]*>Doubt</);
    expect(html).toContain(
      '<time dateTime="2026-10-21T20:00:00Z">21 October 2026</time>',
    );
  });

  it('has the share button and a pull quote for written stories', async () => {
    mockGet.mockResolvedValue({ kind: 'story', story });
    const html = renderToStaticMarkup(await StoryPage(params('test-story')));
    expect(html).toContain('>Share</button>');
    expect(html).toMatch(/<blockquote[^>]*>.*Placeholder.*<\/blockquote>/s);
  });

  it('shows related stories and the next-steps invitation', async () => {
    mockGet.mockResolvedValue({ kind: 'story', story });
    const html = renderToStaticMarkup(await StoryPage(params('test-story')));
    expect(mockRelated).toHaveBeenCalledWith('test-story');
    expect(html).toContain('Related stories');
    expect(html).toMatch(
      /href="\/stories\/related-one"[^>]*>.*A related story/s,
    );
    expect(html).toContain('Audio · 1:05');
    expect(html).toMatch(/href="\/next-steps"/);
  });

  it('still renders when related stories can’t load', async () => {
    mockGet.mockResolvedValue({ kind: 'story', story });
    mockRelated.mockRejectedValue(new StoriesUnavailableError('status 503'));
    const html = renderToStaticMarkup(await StoryPage(params('test-story')));
    expect(html).toContain('Test story</h1>');
    expect(html).not.toContain('Related stories');
  });

  it('describes the story for search and share previews (Open Graph, schema.org)', async () => {
    mockGet.mockResolvedValue({ kind: 'story', story });
    // pageMetadata (lib/seo.ts) builds absolute URLs from SITE_URL, read per request.
    process.env['SITE_URL'] = 'https://example.org';
    const meta = await generateMetadata(params('test-story'));
    delete process.env['SITE_URL'];
    expect(meta.title).toBe('Test story');
    expect(meta.description).toBe('Placeholder');
    expect(meta.alternates?.canonical).toBe(
      'https://example.org/stories/test-story',
    );
    expect(meta.openGraph).toMatchObject({
      type: 'article',
      title: 'Test story',
      url: 'https://example.org/stories/test-story',
      publishedTime: '2026-10-21T20:00:00Z',
      tags: ['Doubt'],
      images: [
        expect.objectContaining({ url: 'https://example.org/og-default.png' }),
      ],
    });
    expect(meta.twitter).toMatchObject({ card: 'summary_large_image' });
    const html = renderToStaticMarkup(await StoryPage(params('test-story')));
    const ld = /<script type="application\/ld\+json">(.*?)<\/script>/.exec(
      html,
    );
    expect(JSON.parse(ld?.[1] ?? 'null')).toMatchObject({
      '@type': 'Article',
      headline: 'Test story',
      datePublished: '2026-10-21T20:00:00Z',
    });
  });

  it('embeds a video story’s signed player (D52)', async () => {
    mockGet.mockResolvedValue({
      kind: 'story',
      story: {
        ...story,
        primaryFormat: 'video',
        media: [
          {
            format: 'video',
            playbackUrl:
              'https://player.mediadelivery.net/embed/1/b8a77258-abfd-469d-ba63-9b89b62fcce6?token=t&expires=1',
            thumbnailUrl: null,
            width: 640,
            height: 360,
            captionsUrl: null,
            durationSeconds: 10,
          },
        ],
        image: null,
      },
    });
    const html = renderToStaticMarkup(await StoryPage(params('test-story')));
    expect(html).toContain(
      'src="https://player.mediadelivery.net/embed/1/b8a77258-abfd-469d-ba63-9b89b62fcce6?token=t&amp;expires=1&amp;autoplay=false&amp;preload=false"',
    );
  });

  it('answers 404 for an unknown slug', async () => {
    mockGet.mockResolvedValue({ kind: 'not_found' });
    await expect(StoryPage(params('nope'))).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFound).toHaveBeenCalled();
  });

  it('redirects an old slug to the current one (D30)', async () => {
    mockGet.mockResolvedValue({ kind: 'story', story });
    await expect(StoryPage(params('old-slug'))).rejects.toThrow(
      'REDIRECT /stories/test-story',
    );
    expect(permanentRedirect).toHaveBeenCalledWith('/stories/test-story');
  });

  it('lets an unavailable api-public-read reach the error page', async () => {
    mockGet.mockRejectedValue(new StoriesUnavailableError('status 503'));
    await expect(StoryPage(params('test-story'))).rejects.toBeInstanceOf(
      StoriesUnavailableError,
    );
    expect(await generateMetadata(params('test-story'))).toEqual({});
  });
});
