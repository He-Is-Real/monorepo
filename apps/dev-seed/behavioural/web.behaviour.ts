import { expect, test } from '@playwright/test';
import { DATASET } from '../src/app/dataset';

// web on dev, after a reset: the pages a visitor sees show the dummy dataset through
// api-public-read (D32).
const story = (id: string) => {
  const s = DATASET.stories.find((x) => x.id === id);
  if (!s) throw new Error(`no ${id} in the dataset`);
  return s;
};

test('the home page shows the three newest stories', async ({
  page,
}) => {
  // Newest first, never a chosen one (Joel, 2026-10-23: no featured stories).
  const newest = DATASET.stories
    .filter((s) => s.status === 'approved')
    .sort((a, b) => (a.publishedDaysAgo ?? 0) - (b.publishedDaysAgo ?? 0))
    .slice(0, 3)
    .map((s) => s.title);
  await page.goto('/');
  await expect(page.locator('main article h3')).toHaveText(newest);
});

for (const id of ['seed_w07', 'seed_w03', 'seed_v06', 'seed_a03']) {
  test(`the story page of ${id} shows its title`, async ({ page }) => {
    const res = await page.goto(`/stories/${story(id).slug}`);
    expect(res?.status()).toBe(200);
    await expect(
      page.getByRole('heading', { name: story(id).title }),
    ).toBeVisible();
  });
}

test('a story that isn’t approved is a 404', async ({ page }) => {
  const res = await page.goto(`/stories/${story('seed_w09').slug}`);
  expect(res?.status()).toBe(404);
});

// M1 step 6b-1: browse, search and related stories on dev, over the D47 dataset.
const published = DATASET.stories.filter((s) => s.status === 'approved');
const unpublished = DATASET.stories.filter((s) => s.status !== 'approved');
const cards = (page: import('@playwright/test').Page) =>
  page.locator('main ul.masonry > li');

test('browse lists the published stories, loads the rest on its own, and nothing else', async ({
  page,
}) => {
  await page.goto('/stories');
  await expect(
    page.getByRole('heading', { level: 1, name: 'God Stories' }),
  ).toBeVisible();
  await expect(cards(page)).toHaveCount(Math.min(15, published.length));
  await page.evaluate(() =>
    window.scrollTo(0, document.documentElement.scrollHeight),
  );
  await expect(page.getByText('You’ve seen every story here.')).toBeVisible();
  const titles = await cards(page).locator('h3').allTextContents();
  for (const title of titles)
    expect(published.map((s) => s.title)).toContain(title);
  for (const s of unpublished) expect(titles).not.toContain(s.title);
});

test('search finds a story by a word in its title', async ({ page }) => {
  await page.goto('/stories');
  await page.getByLabel('Search stories').fill('panorama');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page).toHaveURL(/q=panorama/);
  await expect(cards(page).first().locator('h3')).toHaveText(
    story('seed_w04').title,
  );
});

test('a video card shows its signed thumbnail', async ({ page }) => {
  await page.goto('/stories?format=video');
  const img = cards(page).first().locator('img');
  await expect(img).toBeVisible();
  await expect
    .poll(() => img.evaluate((i: HTMLImageElement) => i.naturalWidth))
    .toBeGreaterThan(0);
  expect(await img.getAttribute('src')).toMatch(/[?&]token=/);
});

test('a story page shows related stories and the share button', async ({
  page,
}) => {
  await page.goto(`/stories/${story('seed_v03').slug}`);
  await expect(
    page.getByRole('heading', { name: 'Related stories' }),
  ).toBeVisible();
  const related = page.getByRole('region', { name: 'Related stories' });
  await expect(related.getByRole('link')).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Share' })).toBeVisible();
});
