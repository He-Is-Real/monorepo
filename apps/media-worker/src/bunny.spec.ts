import { BunnyStreamReader, checkAnswer } from './bunny';

/**
 * What the worker tells the writer about a video, from what Bunny's API says about it (the
 * `MediaAnswer` of libs/contracts worker.yaml), and the failure codes when Bunny can't say.
 */
const VIDEO = '0f8fad5b-d9cb-469f-a165-70867728950e';
const STORY = '01JC0000000000000000000000';
const finished = {
  guid: VIDEO,
  title: STORY,
  status: 4,
  width: 1920,
  height: 1080,
  length: 73,
  thumbnailFileName: 'thumbnail.jpg',
};

function reader(answer: () => Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const bunny = new BunnyStreamReader(
    '789855',
    async () => 'readonly-key-for-tests',
    async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return answer();
    },
  );
  return { bunny, calls };
}
const json =
  (body: unknown, status = 200) =>
  async () =>
    new Response(JSON.stringify(body), { status });

describe('checking a video at Bunny', () => {
  it('answers ready with its facts once Bunny has finished encoding it', async () => {
    const { bunny, calls } = reader(json(finished));
    await expect(checkAnswer(bunny, VIDEO)).resolves.toEqual({
      answer: {
        outcome: 'ready',
        title: STORY,
        width: 1920,
        height: 1080,
        lengthSeconds: 73,
        thumbnailFileName: 'thumbnail.jpg',
      },
    });
    // The library's read-only key, to Bunny's API only.
    expect(calls[0].url).toBe(
      `https://video.bunnycdn.com/library/789855/videos/${VIDEO}`,
    );
    expect((calls[0].init.headers as Record<string, string>)['AccessKey']).toBe(
      'readonly-key-for-tests',
    );
    expect(calls[0].init.redirect).toBe('error');
  });

  it.each([
    [0, 'encoding'],
    [1, 'encoding'],
    [2, 'encoding'],
    [3, 'encoding'],
    [7, 'encoding'],
    [8, 'encoding'],
    [5, 'failed'],
    [6, 'failed'],
  ])('answers Bunny status %i as %s', async (status, outcome) => {
    const { bunny } = reader(json({ ...finished, status }));
    await expect(checkAnswer(bunny, VIDEO)).resolves.toEqual({
      answer: { outcome },
    });
  });

  it('answers gone when Bunny has no such video', async () => {
    const { bunny } = reader(async () => new Response('', { status: 404 }));
    await expect(checkAnswer(bunny, VIDEO)).resolves.toEqual({
      answer: { outcome: 'gone' },
    });
  });

  it.each([
    [
      'a finished video without a length',
      { ...finished, length: 0 },
      'bunny_facts_missing',
    ],
    [
      'a finished video without a title',
      { ...finished, title: '' },
      'bunny_facts_missing',
    ],
    [
      'a thumbnail name that is a path',
      { ...finished, thumbnailFileName: '../x.jpg' },
      'bunny_facts_missing',
    ],
    [
      'a status we do not know',
      { ...finished, status: 99 },
      'bunny_unknown_status',
    ],
  ])('reports a failure for %s', async (_, body, code) => {
    const { bunny } = reader(json(body));
    await expect(checkAnswer(bunny, VIDEO)).resolves.toEqual({ failure: code });
  });

  it.each([
    [401, 'bunny_refused'],
    [403, 'bunny_refused'],
    [429, 'bunny_unreachable'],
    [503, 'bunny_unreachable'],
    [418, 'bunny_error'],
  ])('reports Bunny answering %i as %s', async (status, code) => {
    const { bunny } = reader(async () => new Response('no', { status }));
    await expect(checkAnswer(bunny, VIDEO)).resolves.toEqual({ failure: code });
  });

  it('reports bunny_unreachable when Bunny cannot be reached', async () => {
    const { bunny } = reader(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(checkAnswer(bunny, VIDEO)).resolves.toEqual({
      failure: 'bunny_unreachable',
    });
  });

  it('reports key_unavailable when the read-only key cannot be read', async () => {
    const bunny = new BunnyStreamReader(
      '789855',
      async () => {
        throw new Error('PERMISSION_DENIED');
      },
      async () => new Response(JSON.stringify(finished)),
    );
    await expect(checkAnswer(bunny, VIDEO)).resolves.toEqual({
      failure: 'key_unavailable',
    });
  });
});
