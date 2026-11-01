import { expect, test } from '@playwright/test';
import { STUB_LIVE_PORT, WEB_LIVE_URL } from './servers';

// D51 (and GDPR Art 9): once a story is withdrawn or erased, the next request for anything that
// showed it no longer does. Nothing web fetches about a story is cached: the story page and
// its title and share preview, other stories' related lists, home's newest stories and the
// sitemap. Codex review of #72, round 3: the unit test that checked the story fetch's options
// was the only guard, and a cached fetch served a withdrawn testimony after the API said 404.
//
// On the live server (it has the sitemap), whose stub API alone has the withdrawal-test
// story, so nothing else sees it come and go. One device, in order: none of this depends on
// the screen.

const SLUG = 'withdrawal-test';
const TITLE = 'Withdrawal test story';
const TEXT = 'Withdrawal test testimony text';
// No themes, so its related list is the newest stories, withdrawal-test first.
const NEIGHBOUR = '/stories/test-story-walking-skeleton';
const stub = `http://127.0.0.1:${STUB_LIVE_PORT}/__test`;

test.use({ baseURL: WEB_LIVE_URL });

// Only this test, on one project, ever withdraws or restores the story: no hook does, because
// the other projects' hooks run while they skip, and a restore landing mid-test made the
// story page answer 200 (Codex review of #72, round 4).
test('a withdrawn story is gone from every page that showed it, on the next request', async ({
  page,
  request,
}, info) => {
  test.skip(info.project.name !== 'desktop-1280', 'one device');
  await request.post(`${stub}/show?slug=${SLUG}`);
  const card = page.getByRole('link', { name: TITLE });
  const sitemapHas = async () =>
    (await (await request.get('/sitemap.xml')).text()).includes(
      `/stories/${SLUG}</loc>`,
    );

  // Published: each place shows it (and the server has fetched it once).
  expect((await page.goto(`/stories/${SLUG}`))?.status()).toBe(200);
  await expect(page.getByText(TEXT)).toBeVisible();
  await expect(page).toHaveTitle(new RegExp(TITLE));
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
    'content',
    new RegExp(TITLE),
  );
  await page.goto(NEIGHBOUR);
  await expect(
    page
      .getByRole('complementary', { name: 'Keep exploring' })
      .getByRole('link', { name: TITLE }),
  ).toBeVisible();
  await page.goto('/');
  await expect(card).toBeVisible();
  expect(await sitemapHas()).toBe(true);

  await request.post(`${stub}/hide?slug=${SLUG}`);
  try {
    // Withdrawn: the story page is a 404 without its text, title or share preview.
    expect((await page.goto(`/stories/${SLUG}`))?.status()).toBe(404);
    await expect(page.getByText(TEXT)).toHaveCount(0);
    await expect(page).not.toHaveTitle(new RegExp(TITLE));
    await expect(
      page.locator(`meta[content*="${TITLE}"], meta[content*="${SLUG}"]`),
    ).toHaveCount(0);
    expect(await page.content()).not.toContain(TEXT);
    // Not in another story's related list, home's newest stories or the sitemap.
    await page.goto(NEIGHBOUR);
    await expect(
      page.getByRole('complementary', { name: 'Keep exploring' }),
    ).toBeVisible();
    await expect(card).toHaveCount(0);
    await page.goto('/');
    await expect(page.getByRole('main')).toBeVisible();
    await expect(card).toHaveCount(0);
    expect(await sitemapHas()).toBe(false);
  } finally {
    await request.post(`${stub}/show?slug=${SLUG}`);
  }
});
