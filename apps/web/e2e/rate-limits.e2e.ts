import { expect, test } from '@playwright/test';
import { RATE_LIMITS } from '@heisreal/http/rate-limits';
import { BEHAVIOUR_DEVICES } from './devices';
import { WEB_LIMITED_URL } from './servers';

// Rate limits in the website (RL-8 A, Joel 2026-11-21): proxy.ts counts each visitor's page
// loads and server actions by address. A visitor over the limit sees only the site's generic
// error, "Something went wrong. Please try again later.", with status 500, and nothing that says
// it was a limit (RL-5). Runs against the one e2e server with limits on, whose clock stands still
// (E2E_NOW), so counts never slide away mid-test; each test and device has addresses of its own.

// eslint-disable-next-line no-empty-pattern
test.beforeEach(({}, info) => {
  test.skip(
    !BEHAVIOUR_DEVICES.includes(info.project.name),
    'one phone and one desktop',
  );
});

/** A visitor address of this test's own (the server only reads the last forwarded entry). */
function address(project: string, n: number): string {
  const device = BEHAVIOUR_DEVICES.indexOf(project) + 1;
  return `203.0.${device * 10 + n}.1`;
}

test('a visitor over the page limit sees only the generic error', async ({
  page,
  request,
}, info) => {
  const visitor = address(info.project.name, 1);
  const as = (ip: string) => ({ headers: { 'x-forwarded-for': ip } });
  const { limit } = RATE_LIMITS.webPages;
  for (let i = 0; i < limit; i++) {
    const res = await request.get(`${WEB_LIMITED_URL}/about`, as(visitor));
    expect(res.status()).toBe(200);
  }
  const limited = await request.get(`${WEB_LIMITED_URL}/about`, as(visitor));
  expect(limited.status()).toBe(500);
  expect(limited.headers()['cache-control']).toBe('no-store');
  for (const name of Object.keys(limited.headers())) {
    expect(name).not.toMatch(/ratelimit|retry-after/i);
  }
  expect(await limited.text()).not.toMatch(/limit|too many|429/i);

  // In the browser: the generic message and a way home.
  await page.setExtraHTTPHeaders({ 'x-forwarded-for': visitor });
  await page.goto(`${WEB_LIMITED_URL}/about`);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Something went wrong' }),
  ).toBeVisible();
  await expect(page.getByRole('main')).toContainText('Please try again later.');
  await expect(
    page.getByRole('link', { name: 'Go to the home page' }),
  ).toBeVisible();

  // Another visitor is unaffected.
  const other = await request.get(
    `${WEB_LIMITED_URL}/about`,
    as(address(info.project.name, 2)),
  );
  expect(other.status()).toBe(200);
});

test('the sitemap has its own small allowance', async ({ request }, info) => {
  const as = { headers: { 'x-forwarded-for': address(info.project.name, 3) } };
  for (let i = 0; i < RATE_LIMITS.webSitemap.limit; i++) {
    // Dev has no sitemap (indexing off): 404, still counted.
    expect(
      (await request.get(`${WEB_LIMITED_URL}/sitemap.xml`, as)).status(),
    ).toBe(404);
  }
  expect(
    (await request.get(`${WEB_LIMITED_URL}/sitemap.xml`, as)).status(),
  ).toBe(500);
  // Pages are counted separately.
  expect((await request.get(`${WEB_LIMITED_URL}/about`, as)).status()).toBe(
    200,
  );
});
