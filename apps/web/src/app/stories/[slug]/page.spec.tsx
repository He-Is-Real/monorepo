/**
 * @jest-environment node
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { notFound, permanentRedirect } from 'next/navigation';
import StoryPage, { generateMetadata } from './page';
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
  afterEach(() => jest.clearAllMocks());

  it('renders the story server-side, anonymous byline and tags included', async () => {
    mockGet.mockResolvedValue({ kind: 'story', story });
    const html = renderToStaticMarkup(await StoryPage(params('test-story')));
    expect(html).toContain('Test story</h1>');
    expect(html).toContain('Anonymous');
    expect(html).toContain('aria-label="Tags"');
    expect(await generateMetadata(params('test-story'))).toEqual({
      title: 'Test story',
      description: 'Placeholder',
    });
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
