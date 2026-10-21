/**
 * @jest-environment node
 */
import { getPublicStory, StoriesUnavailableError } from './public-stories';

const story = {
  id: 'dev_seed',
  slug: 'test-story',
  title: 'Test story',
  description: 'Placeholder',
  body: null,
  bylineName: null,
  primaryFormat: 'written',
  tags: [],
  publishedAt: '2026-10-21T20:00:00Z',
  version: 1,
};

describe('getPublicStory', () => {
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

  it('fetches the story from api-public-read only, with nothing from the visitor', async () => {
    respond(200, story);
    await expect(getPublicStory('test-story')).resolves.toEqual({
      kind: 'story',
      story,
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api-public-read.example/v1/stories/test-story');
    expect(init.headers).toEqual({ accept: 'application/json' });
    expect(init.cache).toBe('no-store');
  });

  it('maps 404 to not_found, and never asks about invalid slugs', async () => {
    respond(404, { status: 404 });
    await expect(getPublicStory('gone')).resolves.toEqual({
      kind: 'not_found',
    });
    await expect(getPublicStory('../health')).resolves.toEqual({
      kind: 'not_found',
    });
    await expect(getPublicStory('UPPER')).resolves.toEqual({
      kind: 'not_found',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a 5xx', () => respond(503, { status: 503 })],
    ['an unexpected body', () => respond(200, { nope: true })],
    [
      'a network failure',
      () => fetchMock.mockRejectedValue(new TypeError('fetch failed')),
    ],
  ])('throws StoriesUnavailableError on %s', async (_name, arrange) => {
    arrange();
    await expect(getPublicStory('test-story')).rejects.toBeInstanceOf(
      StoriesUnavailableError,
    );
  });
});
