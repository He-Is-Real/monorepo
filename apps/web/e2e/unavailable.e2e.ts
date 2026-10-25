import { expect, test } from '@playwright/test';
import { WEB_DOWN_URL, WEB_LIVE_URL } from './servers';

// When api-public-read can't be reached, the story page says so in the page the server sends,
// so visitors without JavaScript get it too, with a link back to Stories, like browse (Joel,
// 2026-10-25: the page answers 200, as browse does; Next.js can't send a page with a 5xx). It
// isn't indexed at Go live. The fit of the message is checked on every device in
// responsive.e2e.ts; this runs on one phone and one desktop.

// eslint-disable-next-line no-empty-pattern
test.beforeEach(({}, info) => {
  test.skip(
    !['phone-320', 'desktop-1280'].includes(info.project.name),
    'one phone and one desktop',
  );
});

for (const js of [false, true]) {
  test.describe(js ? 'with JavaScript' : 'without JavaScript', () => {
    test.use({ javaScriptEnabled: js });

    test('a story page says the story can’t be shown, with a way back to Stories', async ({
      page,
    }) => {
      await page.goto('/stories/down');
      await expect(page.getByRole('banner')).toBeVisible();
      await expect(
        page.getByRole('heading', {
          level: 1,
          name: 'This story can’t be shown right now',
        }),
      ).toBeVisible();
      await page
        .getByRole('main')
        .getByRole('link', { name: 'Browse stories' })
        .click();
      await expect(page).toHaveURL(/\/stories$/);
    });

    test('browse says stories can’t be loaded', async ({ page }) => {
      await page.goto(`${WEB_DOWN_URL}/stories`);
      await expect(
        page.getByText('Stories can’t be loaded right now.'),
      ).toBeVisible();
    });
  });
}

test('at Go live, the story page’s outage message isn’t indexed', async ({
  page,
}) => {
  await page.goto(`${WEB_LIVE_URL}/stories/down`);
  await expect(
    page.getByRole('heading', { name: 'This story can’t be shown right now' }),
  ).toBeVisible();
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
    'content',
    /noindex/,
  );
});
