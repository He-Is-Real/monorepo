import { expect, test } from '@playwright/test';
import { DATASET } from '../src/app/dataset';

// web on dev, after a reset: the pages a visitor sees show the dummy dataset through
// api-public-read (D32), with D48's footer note.
const story = (id: string) => {
  const s = DATASET.stories.find((x) => x.id === id);
  if (!s) throw new Error(`no ${id} in the dataset`);
  return s;
};

test('the home page shows the featured story and the relaxed-consent note', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByText(story('seed_w06').title).first()).toBeVisible();
  await expect(page.getByText('Consent checks relaxed (dev)')).toBeVisible();
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
