import { expect, type Page, test } from '@playwright/test';
import { TRY_AGAIN_LATER } from '../src/lib/try-again-later';
import { CACHED_TIMES, STUB_CACHED_URL, WEB_CACHED_URL } from './servers';

// Page caching (Joel, 2026-11-21): a public page's saved copy is served for its time and never
// after it, even when the refresh fails (D51's problem: an old copy kept while the API is down).
// On the page-cache server only (production's column, with test times: home and About 1 hour, Stories
// 1 second), whose stub port nothing else uses. Every other server runs dev's column.
//
// One device, in order: the tests share that port's hidden stories and its "failing" switch.

test.use({ baseURL: WEB_CACHED_URL });
test.describe.configure({ mode: 'serial' });

// eslint-disable-next-line no-empty-pattern
test.beforeEach(({}, info) => {
  test.skip(info.project.name !== 'desktop-1280', 'one device');
});

const hook = (page: Page, path: string) =>
  page.request.post(`${STUB_CACHED_URL}/__test/${path}`);

/** The first story card's address in `scope`, e.g. "/stories/some-slug". */
async function firstStory(page: Page, scope: string): Promise<string> {
  const href = await page
    .locator(`${scope} a[href^="/stories/"]`)
    .first()
    .getAttribute('href');
  if (!href) throw new Error('no story card');
  return href;
}

const card = (page: Page, href: string) =>
  page.getByRole('main').locator(`a[href="${href}"]`);

test('within its time, home is the saved copy, still noindex', async ({
  page,
}) => {
  expect(CACHED_TIMES['/']).toBeGreaterThanOrEqual(3600);
  await page.goto('/');
  const href = await firstStory(page, 'section[aria-labelledby="newest"]');
  await hook(page, `hide?slug=${href.slice('/stories/'.length)}`);
  try {
    // The API no longer lists it, but home's copy is under an hour old.
    const again = await page.reload();
    await expect(card(page, href).first()).toBeVisible();
    // The proxy's header still reaches a saved page (dev isn't indexed).
    expect(again?.headers()['x-robots-tag']).toBe('noindex, nofollow');
  } finally {
    await hook(page, `show?slug=${href.slice('/stories/'.length)}`);
  }
});

test('after its time, Stories shows the change', async ({ page }) => {
  await page.goto('/stories');
  const href = await firstStory(page, 'main');
  await hook(page, `hide?slug=${href.slice('/stories/'.length)}`);
  try {
    await expect(async () => {
      await page.reload();
      await expect(card(page, href)).toHaveCount(0);
    }).toPass();
  } finally {
    await hook(page, `show?slug=${href.slice('/stories/'.length)}`);
  }
});

test('after its time, a failed refresh is "try again later", never the old copy', async ({
  page,
}) => {
  await page.goto('/stories');
  const href = await firstStory(page, 'main');
  // The copy was saved by now; it has expired once its time (1 s) has passed.
  const saved = Date.now();
  await hook(page, 'fail');
  try {
    await expect
      .poll(() => Date.now() - saved, { intervals: [250] })
      .toBeGreaterThan(CACHED_TIMES['/stories'] * 1000 + 500);
    await page.reload();
    await expect(page.getByText(TRY_AGAIN_LATER)).toBeVisible();
    await expect(card(page, href)).toHaveCount(0);
  } finally {
    await hook(page, 'recover');
  }
  // The failed render wasn't saved: the next visit has the stories again.
  await page.reload();
  await expect(card(page, href).first()).toBeVisible();
});

test('a failed video lookup is never saved: the next visit plays the video', async ({
  page,
}) => {
  // About's first visit on this server, with api-public-read failing: the placeholder, and no
  // copy kept (About's test time is an hour, so a kept copy would still show it below).
  expect(CACHED_TIMES['/about']).toBeGreaterThanOrEqual(3600);
  await hook(page, 'fail');
  try {
    await page.goto('/about');
    await expect(
      page.getByRole('main').getByText('Video coming soon'),
    ).toBeVisible();
  } finally {
    await hook(page, 'recover');
  }
  await page.reload();
  await expect(
    page.getByRole('main').getByTitle(/^Video: The heart behind He Is Real/),
  ).toBeVisible();
  // That copy had the video, so it was kept: the video stays while the API is down.
  await hook(page, 'fail');
  try {
    await page.reload();
    await expect(
      page.getByRole('main').getByTitle(/^Video: The heart behind He Is Real/),
    ).toBeVisible();
  } finally {
    await hook(page, 'recover');
  }
});
