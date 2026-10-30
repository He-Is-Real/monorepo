import { expect, type Page, test } from '@playwright/test';
import { BEHAVIOUR_DEVICES } from './devices';
import {
  STUB_SLOW_URL,
  WEB_DOWN_URL,
  WEB_LIVE_URL,
  WEB_SLOW_URL,
} from './servers';

// The founder's videos on About and Next Steps: Bunny's player with the signed link
// api-public-read gives (`/v1/site-videos/{key}`), and the placeholder wherever there's no video,
// so the page never breaks. The stub sets both on dev's port only; the Go live port has none and
// the down port answers 503, and the slow port holds the link until the test lets it go
// (stub-api.mjs). Fit on every device: static-pages.e2e.ts.

const PAGES = [
  {
    path: '/about',
    key: 'founder-intro',
    h1: 'The heart behind He Is Real',
    title: /^Video: The heart behind He Is Real/,
    guid: '0b6f1c3e-2d4a-4c5b-8e9f-1a2b3c4d5e6f',
  },
  {
    path: '/next-steps',
    key: 'next-steps',
    h1: 'Next steps',
    title: /^Video: Next steps with He Is Real/,
    guid: '7c2e9a14-5b3d-4f6e-a8c1-2d3e4f5a6b7c',
  },
] as const;

/**
 * The placeholder in the page. Scoped to main: while the page streams, React keeps the
 * finished part in a hidden element outside it until it swaps it in.
 */
const comingSoon = (page: Page) =>
  page.getByRole('main').getByText('Video coming soon');

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
    const player = page.getByRole('main').getByTitle(p.title);
    await expect(player).toBeVisible();
    const src = new URL((await player.getAttribute('src')) ?? '');
    expect(src.pathname).toBe(`/embed/1/${p.guid}`);
    expect(src.searchParams.get('token')).toBe('stub');
    expect(src.searchParams.get('autoplay')).toBe('false');
    // The stand-in player loaded in the frame.
    await expect(
      page.frameLocator('main iframe').getByRole('button', { name: 'Play' }),
    ).toBeVisible();
    await expect(comingSoon(page)).toHaveCount(0);
  });

  test(`${p.path}: shows the page at once and streams the player in when the link is slow`, async ({
    page,
    request,
  }, info) => {
    // One device: the stub holds each key's link until this test releases it (stub-api.mjs).
    test.skip(info.project.name !== 'desktop-1280', 'one run per key');
    // While the link is held, the page is already there with its placeholder. If the page
    // waited for the link, nothing would show until the release.
    await page.goto(`${WEB_SLOW_URL}${p.path}`, { waitUntil: 'commit' });
    await expect(
      page.getByRole('heading', { level: 1, name: p.h1 }),
    ).toBeVisible();
    await expect(comingSoon(page)).toBeVisible();
    await expect(page.locator('main iframe')).toHaveCount(0);
    // Then the link comes, and the player takes the placeholder's place.
    expect(
      (
        await request.post(
          `${STUB_SLOW_URL}/__test/release-site-video/${p.key}`,
        )
      ).status(),
    ).toBe(204);
    await expect(page.getByRole('main').getByTitle(p.title)).toBeVisible();
    await expect(comingSoon(page)).toHaveCount(0);
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
      await expect(comingSoon(page)).toBeVisible();
      await expect(page.locator('main iframe, main video')).toHaveCount(0);
    });
  }
}
