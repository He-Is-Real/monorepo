/**
 * @jest-environment node
 */
import { StoriesUnavailableError } from '@/lib/public-stories';
import { collectStoryEntries } from '@/lib/sitemap';
import { dynamic, GET } from './route';

jest.mock('@/lib/sitemap', () => ({
  ...jest.requireActual('@/lib/sitemap'),
  collectStoryEntries: jest.fn(),
}));
const collect = jest.mocked(collectStoryEntries);

describe('GET /sitemap.xml', () => {
  const saved = {
    INDEXING: process.env['INDEXING'],
    SITE_URL: process.env['SITE_URL'],
  };
  afterEach(() => {
    collect.mockReset();
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const live = () => {
    process.env['INDEXING'] = 'allow';
    process.env['SITE_URL'] = 'https://www.heisreal.today';
  };

  it('is built per request', () => {
    expect(dynamic).toBe('force-dynamic');
  });

  it('doesn’t exist in dev (INDEXING unset), and doesn’t ask the API', async () => {
    delete process.env['INDEXING'];
    process.env['SITE_URL'] = 'https://web-abc-nw.a.run.app';
    const res = await GET();
    expect(res.status).toBe(404);
    expect(collect).not.toHaveBeenCalled();
  });

  it('doesn’t exist without a site URL', async () => {
    process.env['INDEXING'] = 'allow';
    delete process.env['SITE_URL'];
    expect((await GET()).status).toBe(404);
  });

  it('lists the pages and published stories at Go live, uncached (D51)', async () => {
    live();
    collect.mockResolvedValue([
      { slug: 'a-story', publishedAt: '2026-10-21T20:00:00Z' },
    ]);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(
      'application/xml; charset=utf-8',
    );
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.text();
    expect(body).toContain('<loc>https://www.heisreal.today/about</loc>');
    expect(body).toContain(
      '<loc>https://www.heisreal.today/stories/a-story</loc>',
    );
  });

  it('answers 503 with Retry-After while api-public-read is down', async () => {
    live();
    collect.mockRejectedValue(new StoriesUnavailableError('status 503'));
    const res = await GET();
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('300');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('lets anything else fail loudly', async () => {
    live();
    collect.mockRejectedValue(new TypeError('bug'));
    await expect(GET()).rejects.toThrow('bug');
  });
});
