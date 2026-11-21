import { expect, test } from '@playwright/test';
import { RATE_LIMITS } from '@heisreal/http/rate-limits';
import { BEHAVIOUR_DEVICES } from './devices';
import { WEB_LIMITED_URL } from './servers';

// Rate limits in the website (RL-8 A, Joel 2026-11-21): proxy.ts counts each visitor's page
// loads and server actions by address. A visitor over the limit gets exactly what a crash gives
// (RL-5): status 500 and the site's error page (app/error.tsx), with a crash's headers. Runs against the one e2e server with limits on, whose clock stands still
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

/** A real crash: the page that fails to render, on a server with limits off (WEB_URL). */
const CRASH_URL = '/something-went-wrong';

/**
 * Headers a limited answer must share with a real crash. Next adds one more to a limited one,
 * `x-middleware-rewrite` (it marks every rewrite; the limiter rewrites to the crash page).
 */
const SAME_HEADERS = [
  'content-type',
  'cache-control',
  'vary',
  'link',
  'x-robots-tag',
];

test('a visitor over the page limit gets exactly what a crash gives', async ({
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
  const crash = await request.get(CRASH_URL);
  expect(crash.status()).toBe(500);
  expect(limited.status()).toBe(crash.status());
  for (const name of SAME_HEADERS) {
    expect(limited.headers()[name], name).toBe(crash.headers()[name]);
  }
  const extra = Object.keys(limited.headers()).filter(
    (name) => !(name in crash.headers()),
  );
  expect(extra).toEqual(['x-middleware-rewrite']);
  expect(await limited.text()).not.toMatch(/limit|too many|429/i);

  // A server action (a POST with Next's action header): a crash's status, and the action never
  // runs (an unknown action would otherwise be "not found", 404).
  const action = await request.post(`${WEB_LIMITED_URL}/about`, {
    headers: {
      'x-forwarded-for': visitor,
      'next-action': '00'.repeat(21),
      'content-type': 'text/plain;charset=UTF-8',
    },
    data: '[]',
  });
  expect(action.status()).toBe(500);
  expect(await action.text()).not.toMatch(/limit|too many|429/i);

  // In the browser: the site's error page, as a crash shows it, with its "Try again" button.
  for (const url of [CRASH_URL, `${WEB_LIMITED_URL}/about`]) {
    await page.setExtraHTTPHeaders({ 'x-forwarded-for': visitor });
    await page.goto(url);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Something went wrong' }),
    ).toBeVisible();
    await expect(page.getByRole('main')).toContainText(
      'Please try again later.',
    );
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Go to the home page' }),
    ).toBeVisible();
  }

  // Another visitor is unaffected.
  const other = await request.get(
    `${WEB_LIMITED_URL}/about`,
    as(address(info.project.name, 2)),
  );
  expect(other.status()).toBe(200);
});

test('a visitor who goes over the limit while on a page sees the crash page on their next click', async ({
  page,
  request,
}, info) => {
  const visitor = address(info.project.name, 5);
  const as = { headers: { 'x-forwarded-for': visitor } };
  for (let i = 0; i < RATE_LIMITS.webPages.limit - 1; i++) {
    expect((await request.get(`${WEB_LIMITED_URL}/about`, as)).status()).toBe(
      200,
    );
  }
  // The last page load allowed; the page's own requests from here on (prefetches, the click's
  // navigation) are over the limit.
  await page.setExtraHTTPHeaders(as.headers);
  await page.goto(`${WEB_LIMITED_URL}/about`);
  await expect(
    page.getByRole('heading', {
      level: 1,
      name: 'The heart behind He Is Real',
    }),
  ).toBeVisible();
  await page
    .getByRole('contentinfo')
    .getByRole('link', { name: 'Contact us' })
    .click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Something went wrong' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
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

test('a page path ending like a picture is still counted', async ({
  request,
}, info) => {
  const as = { headers: { 'x-forwarded-for': address(info.project.name, 4) } };
  for (let i = 0; i < RATE_LIMITS.webPages.limit; i++) {
    expect(
      (await request.get(`${WEB_LIMITED_URL}/no-such-page.png`, as)).status(),
    ).toBe(404);
  }
  expect(
    (await request.get(`${WEB_LIMITED_URL}/no-such-page.png`, as)).status(),
  ).toBe(500);
});
