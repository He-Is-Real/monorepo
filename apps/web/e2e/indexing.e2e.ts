import { expect, test } from '@playwright/test';
import { WEB_LIVE_URL } from './servers';

// Go live (indexing on, D48 off) on its own server: crawlers are invited, the sitemap lists
// the pages and published stories, and nothing says noindex. Dev's side (indexing off) is in
// static-pages.e2e.ts. One device: none of this depends on the screen.

test.use({ baseURL: WEB_LIVE_URL });
// eslint-disable-next-line no-empty-pattern
test.beforeEach(({}, info) => {
  test.skip(info.project.name !== 'desktop-1280', 'one device');
});

test('robots.txt invites crawlers, keeps them off /health and lists the sitemap', async ({
  request,
}) => {
  const robots = await request.get('/robots.txt');
  expect(robots.status()).toBe(200);
  const text = await robots.text();
  expect(text).toMatch(/User-Agent: \*\s+Allow: \/\s+Disallow: \/health/i);
  expect(text).toContain(`Sitemap: ${WEB_LIVE_URL}/sitemap.xml`);
});

test('the sitemap lists the pages and published stories, uncached (D51)', async ({
  request,
}) => {
  const sitemap = await request.get('/sitemap.xml');
  expect(sitemap.status()).toBe(200);
  expect(sitemap.headers()['content-type']).toBe(
    'application/xml; charset=utf-8',
  );
  expect(sitemap.headers()['cache-control']).toBe('no-store');
  const xml = await sitemap.text();
  expect(xml).toContain(`<loc>${WEB_LIVE_URL}/about</loc>`);
  expect(xml).toContain(`<loc>${WEB_LIVE_URL}/stories/video-story</loc>`);
  expect(xml).toContain(`<loc>${WEB_LIVE_URL}/stories/browse-test-48</loc>`);
});

test('pages carry no noindex, and the footer has no dev consent note', async ({
  page,
}) => {
  for (const path of ['/', '/stories', '/stories/video-story', '/about']) {
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    expect(response?.headers()['x-robots-tag']).toBeUndefined();
    await expect(page.locator('meta[name="robots"]')).toHaveCount(0);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      'href',
      `${WEB_LIVE_URL}${path === '/' ? '' : path}`,
    );
  }
  await expect(
    page.getByRole('contentinfo').getByText('Consent checks relaxed (dev)'),
  ).toHaveCount(0);
});
