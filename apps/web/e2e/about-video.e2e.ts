import { expect, test } from '@playwright/test';
import { BEHAVIOUR_DEVICES } from './devices';
import { WEB_DOWN_URL, WEB_LIVE_URL } from './servers';

// About's founder video: Bunny's player with the signed link api-public-read gives
// (`/v1/site-videos/founder-intro`), and the placeholder wherever there's no video, so the page
// never breaks. The stub sets it on dev's port only; the Go live port has none and the down port
// answers 503 (stub-api.mjs). Fit on every device: static-pages.e2e.ts.

// eslint-disable-next-line no-empty-pattern
test.beforeEach(({}, info) => {
  test.skip(
    !BEHAVIOUR_DEVICES.includes(info.project.name),
    'behaviour, not layout',
  );
});

test('plays the founder’s introduction when a video is set, without autoplay', async ({
  page,
}) => {
  await page.goto('/about');
  const player = page.getByTitle(/^Video: The heart behind He Is Real/);
  await expect(player).toBeVisible();
  const src = new URL((await player.getAttribute('src')) ?? '');
  expect(src.pathname).toBe('/embed/1/0b6f1c3e-2d4a-4c5b-8e9f-1a2b3c4d5e6f');
  expect(src.searchParams.get('token')).toBe('stub');
  expect(src.searchParams.get('autoplay')).toBe('false');
  // The stand-in player loaded in the frame.
  await expect(
    page.frameLocator('main iframe').getByRole('button', { name: 'Play' }),
  ).toBeVisible();
  await expect(page.getByText('Video coming soon')).toHaveCount(0);
});

for (const [why, base] of [
  ['no video is set', WEB_LIVE_URL],
  ['api-public-read is down', WEB_DOWN_URL],
] as const) {
  test(`shows the placeholder when ${why}`, async ({ page }) => {
    const response = await page.goto(`${base}/about`);
    expect(response?.status()).toBe(200);
    await expect(
      page.getByRole('heading', {
        level: 1,
        name: 'The heart behind He Is Real',
      }),
    ).toBeVisible();
    await expect(page.getByText('Video coming soon')).toBeVisible();
    await expect(page.locator('main iframe, main video')).toHaveCount(0);
  });
}
