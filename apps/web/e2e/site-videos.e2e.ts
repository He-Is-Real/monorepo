import { expect, test } from '@playwright/test';
import { BEHAVIOUR_DEVICES } from './devices';
import { WEB_DOWN_URL, WEB_LIVE_URL } from './servers';

// The founder's videos on About and Next Steps: Bunny's player with the signed link
// api-public-read gives (`/v1/site-videos/{key}`), and the placeholder wherever there's no video,
// so the page never breaks. The stub sets both on dev's port only; the Go live port has none and
// the down port answers 503 (stub-api.mjs). Fit on every device: static-pages.e2e.ts.

const PAGES = [
  {
    path: '/about',
    h1: 'The heart behind He Is Real',
    title: /^Video: The heart behind He Is Real/,
    guid: '0b6f1c3e-2d4a-4c5b-8e9f-1a2b3c4d5e6f',
  },
  {
    path: '/next-steps',
    h1: 'Next steps',
    title: /^Video: Next steps with He Is Real/,
    guid: '7c2e9a14-5b3d-4f6e-a8c1-2d3e4f5a6b7c',
  },
] as const;

// eslint-disable-next-line no-empty-pattern
test.beforeEach(({}, info) => {
  test.skip(
    !BEHAVIOUR_DEVICES.includes(info.project.name),
    'behaviour, not layout',
  );
});

for (const p of PAGES) {
  test(`${p.path}: plays its video when one is set, without autoplay`, async ({
    page,
  }) => {
    await page.goto(p.path);
    const player = page.getByTitle(p.title);
    await expect(player).toBeVisible();
    const src = new URL((await player.getAttribute('src')) ?? '');
    expect(src.pathname).toBe(`/embed/1/${p.guid}`);
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
    test(`${p.path}: shows the placeholder when ${why}`, async ({ page }) => {
      const response = await page.goto(`${base}${p.path}`);
      expect(response?.status()).toBe(200);
      await expect(
        page.getByRole('heading', { level: 1, name: p.h1 }),
      ).toBeVisible();
      await expect(page.getByText('Video coming soon')).toBeVisible();
      await expect(page.locator('main iframe, main video')).toHaveCount(0);
    });
  }
}
