/**
 * @jest-environment node
 */
import { StoriesUnavailableError } from '@/lib/public-stories';
import { SitemapBudgetError, sharedStoryEntries } from '@/lib/sitemap';
import { GET } from './route';

jest.mock('@/lib/sitemap', () => ({
  ...jest.requireActual('@/lib/sitemap'),
  sharedStoryEntries: jest.fn(),
}));
const collect = jest.mocked(sharedStoryEntries);
const request = () => new Request('http://localhost/sitemap.xml');

// The Go-live sitemap itself is checked in e2e/indexing.e2e.ts; these are its failures.
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

  it('answers 503 with Retry-After while api-public-read is down', async () => {
    live();
    collect.mockRejectedValue(new StoriesUnavailableError('status 503'));
    const res = await GET(request());
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('300');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('answers 503 when the walk goes over its budget (time, pages, a cursor loop)', async () => {
    live();
    collect.mockRejectedValue(new SitemapBudgetError('over 20000 ms'));
    const res = await GET(request());
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('300');
  });

  it('answers 503 if the walk was aborted', async () => {
    live();
    collect.mockRejectedValue(new DOMException('aborted', 'AbortError'));
    expect((await GET(request())).status).toBe(503);
  });

  it('lets anything else fail loudly', async () => {
    live();
    collect.mockRejectedValue(new TypeError('bug'));
    await expect(GET(request())).rejects.toThrow('bug');
  });
});
