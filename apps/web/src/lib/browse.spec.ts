/**
 * @jest-environment node
 */
import {
  browseStories,
  getRelatedStories,
  listTags,
  type StorySummary,
} from './browse';
import { StoriesUnavailableError } from './public-stories';

const card: StorySummary = {
  id: 'seed_v01',
  slug: 'test-video',
  title: 'Test video',
  excerpt: 'Dummy video story.',
  bylineName: null,
  primaryFormat: 'video',
  durationSeconds: 12,
  thumbnailUrl: null,
  thumbnailWidth: 360,
  thumbnailHeight: 640,
  image: null,
  textLength: 0,
  tags: [{ slug: 'hope', name: 'Hope', category: 'emotion', version: 1 }],
  publishedAt: '2026-10-21T20:00:00Z',
};

describe('browse client (api-public-read, server-side only)', () => {
  const saved = {
    url: process.env['API_PUBLIC_READ_URL'],
    fetch: global.fetch,
  };
  let fetchMock: jest.Mock;
  beforeEach(() => {
    process.env['API_PUBLIC_READ_URL'] = 'https://api-public-read.example/';
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });
  afterEach(() => {
    global.fetch = saved.fetch;
    if (saved.url === undefined) delete process.env['API_PUBLIC_READ_URL'];
    else process.env['API_PUBLIC_READ_URL'] = saved.url;
  });
  const respond = (status: number, body?: unknown) =>
    fetchMock.mockResolvedValue(
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
      }),
    );
  const called = () => {
    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      RequestInit & { next?: unknown },
    ];
    return { url: new URL(url), init };
  };

  describe('browseStories', () => {
    it('asks for the newest stories, cached for a minute (ISR), with nothing from the visitor', async () => {
      respond(200, { data: [card], nextCursor: 'abc' });
      await expect(browseStories()).resolves.toEqual({
        data: [card],
        nextCursor: 'abc',
      });
      const { url, init } = called();
      expect(url.href).toBe('https://api-public-read.example/v1/stories');
      expect(init.headers).toEqual({ accept: 'application/json' });
      expect(init.next).toEqual({ revalidate: 60 });
      expect(init.cache).toBeUndefined();
    });

    it('sends filters, sort, page size and cursor', async () => {
      respond(200, { data: [], nextCursor: null });
      await browseStories({
        tags: ['healing', 'faith'],
        format: 'video',
        sort: 'oldest',
        limit: 12,
        cursor: 'abc',
      });
      const { url } = called();
      expect(url.searchParams.getAll('tag')).toEqual(['healing', 'faith']);
      expect(Object.fromEntries(url.searchParams)).toMatchObject({
        format: 'video',
        sort: 'oldest',
        limit: '12',
        cursor: 'abc',
      });
    });

    it('fetches searches fresh, so visitors’ words don’t fill the cache', async () => {
      respond(200, { data: [], nextCursor: null });
      await browseStories({ q: '  hope  ' });
      const { url, init } = called();
      expect(url.searchParams.get('q')).toBe('hope');
      expect(init.cache).toBe('no-store');
      expect(init.next).toBeUndefined();
    });

    it('keeps a visitor’s search within the API’s limits', async () => {
      respond(200, { data: [], nextCursor: null });
      await browseStories({
        q: `${'😀'.repeat(250)}`,
        tags: ['a', 'b', 'c', 'd', 'e', 'f'],
      });
      const { url } = called();
      expect([...(url.searchParams.get('q') as string)]).toHaveLength(200);
      expect(url.searchParams.getAll('tag')).toHaveLength(5);
    });

    it('leaves a blank search out', async () => {
      respond(200, { data: [], nextCursor: null });
      await browseStories({ q: '   ' });
      expect(called().url.search).toBe('');
    });

    it.each([
      ['a 400', () => respond(400, { code: 'invalid_cursor' })],
      ['a 5xx', () => respond(503)],
      ['a body without data', () => respond(200, { nextCursor: null })],
      [
        'a card without a size field',
        () =>
          respond(200, {
            data: [{ ...card, thumbnailWidth: undefined }],
            nextCursor: null,
          }),
      ],
      [
        'a network failure',
        () => fetchMock.mockRejectedValue(new TypeError('fetch failed')),
      ],
    ])('throws StoriesUnavailableError on %s', async (_, arrange) => {
      arrange();
      await expect(browseStories()).rejects.toBeInstanceOf(
        StoriesUnavailableError,
      );
    });
  });

  describe('getRelatedStories', () => {
    it('asks for a story’s related cards (following an old slug’s 301)', async () => {
      respond(200, { data: [card] });
      await expect(getRelatedStories('test-story')).resolves.toEqual({
        kind: 'stories',
        stories: [card],
      });
      const { url, init } = called();
      expect(url.href).toBe(
        'https://api-public-read.example/v1/stories/test-story/related',
      );
      expect(init.next).toEqual({ revalidate: 60 });
      expect(init.redirect).toBeUndefined();
    });

    it('maps 404 to not_found, and never asks about invalid slugs', async () => {
      respond(404, { code: 'story_not_found' });
      await expect(getRelatedStories('gone')).resolves.toEqual({
        kind: 'not_found',
      });
      await expect(getRelatedStories('../tags')).resolves.toEqual({
        kind: 'not_found',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('listTags', () => {
    it('lists the tags, cached for a minute', async () => {
      const tags = [
        { slug: 'hope', name: 'Hope', category: 'emotion', version: 1 },
      ];
      respond(200, { data: tags });
      await expect(listTags()).resolves.toEqual(tags);
      const { url, init } = called();
      expect(url.href).toBe('https://api-public-read.example/v1/tags');
      expect(init.next).toEqual({ revalidate: 60 });
    });

    it('throws StoriesUnavailableError on an unexpected body', async () => {
      respond(200, { data: [{ slug: 'hope' }] });
      await expect(listTags()).rejects.toBeInstanceOf(StoriesUnavailableError);
    });
  });
});
