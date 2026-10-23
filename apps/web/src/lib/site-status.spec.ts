/**
 * @jest-environment node
 */
import { consentChecksRelaxed } from './site-status';

describe('consentChecksRelaxed (D48)', () => {
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

  const respond = (status: number, body: unknown) =>
    fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status }));

  it('reads the database’s switch from api-public-read’s health, cached for a minute', async () => {
    respond(200, { status: 'ok', db: 'up', consentChecksRelaxed: true });
    await expect(consentChecksRelaxed()).resolves.toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api-public-read.example/health');
    expect(init.headers).toEqual({ accept: 'application/json' });
    expect(init.next).toEqual({ revalidate: 60 });
  });

  it.each([
    [
      'enforced',
      () => respond(200, { status: 'ok', consentChecksRelaxed: false }),
    ],
    ['not reported', () => respond(200, { status: 'ok', db: 'up' })],
    [
      'a truthy non-boolean',
      () => respond(200, { consentChecksRelaxed: 'true' }),
    ],
    [
      'the database down',
      () => respond(503, { status: 'degraded', consentChecksRelaxed: true }),
    ],
    [
      'a network failure',
      () => fetchMock.mockRejectedValue(new TypeError('fetch failed')),
    ],
  ])('is false when %s', async (_name, arrange) => {
    arrange();
    await expect(consentChecksRelaxed()).resolves.toBe(false);
  });
});
