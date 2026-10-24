/**
 * @jest-environment node
 */
import { browseStories, getRelatedStories, type StorySummary } from './browse';
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
    it('stops when the caller’s signal aborts (the sitemap’s budget, a closed request)', async () => {
      fetchMock.mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(init.signal?.reason),
            );
          }),
      );
      const controller = new AbortController();
      const pending = browseStories({}, { signal: controller.signal });
      controller.abort();
      await expect(pending).rejects.toBeInstanceOf(StoriesUnavailableError);
      expect(called().init.signal?.aborted).toBe(true);
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
    it('never asks about invalid slugs', async () => {
      await expect(getRelatedStories('../tags')).resolves.toEqual({
        kind: 'not_found',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
