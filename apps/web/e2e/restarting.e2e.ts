import { expect, test } from '@playwright/test';
import { BEHAVIOUR_DEVICES } from './devices';

// SurrealDB on Spot (Joel, 2026-11-07): while the database restarts, the API answers
// `503 service_restarting` with when to try again (the stub: 61 seconds). The page says so calmly,
// with the server's estimate in the HTML (so it reads right without JavaScript), counted down in
// the browser and never below "about 1 minute". The fit of the message is checked on every device
// in responsive.e2e.ts; this runs on one phone and one desktop.

// eslint-disable-next-line no-empty-pattern
test.beforeEach(({}, info) => {
  test.skip(
    !BEHAVIOUR_DEVICES.includes(info.project.name),
    'one phone and one desktop',
  );
});

const message = (page: import('@playwright/test').Page) =>
  page.getByRole('main').getByRole('status');

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('a story page says our compute is restarting, with the server’s estimate', async ({
    page,
  }) => {
    await page.goto('/stories/restarting');
    await expect(
      page.getByRole('heading', {
        level: 1,
        name: 'Our compute is currently restarting',
      }),
    ).toBeVisible();
    await expect(message(page)).toHaveText(
      'Please refresh the page in about 2 minutes.',
    );
  });
});

test('the countdown reaches “about 1 minute” and stays there while it is still restarting', async ({
  page,
}) => {
  await page.clock.install();
  await page.goto('/stories/restarting');
  await expect(message(page)).toHaveText(
    'Please refresh the page in about 2 minutes.',
  );
  await page.clock.fastForward('00:02');
  await expect(message(page)).toHaveText(
    'Please refresh the page in about 1 minute.',
  );
  // Long past the estimate: never 0 or negative.
  await page.clock.fastForward('10:00');
  await expect(message(page)).toHaveText(
    'Please refresh the page in about 1 minute.',
  );
});
