import { expect, test } from '@playwright/test';
import { BEHAVIOUR_DEVICES } from './devices';
import { STUB_USER_URL, WEB_SIGNED_IN_URL } from './servers';

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

// An action answered "restarting" (here a heart, against the stub api-user): the notice fixed at
// the bottom of the screen says when to try again, and goes after the next successful answer,
// on the same page or after moving to another one in the browser (Codex review of #194).
test('the notice after an action goes once an answer succeeds, on the page or after moving on', async ({
  page,
}, info) => {
  const project = info.project.name;
  const session =
    `restarting-${project}-r${info.repeatEachIndex}-t${info.retry}`
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-');
  await page.addInitScript(
    (s) => window.localStorage.setItem('e2e-session', s),
    session,
  );
  const id = `heart_test_${project.replace('-', '_')}`;
  let restarting = true;
  await page.route(
    `${STUB_USER_URL}/v1/account/favourites/${id}`,
    async (route) => {
      if (route.request().method() === 'GET' || !restarting)
        return route.fallback();
      restarting = false;
      await route.fulfill({
        status: 503,
        contentType: 'application/problem+json',
        headers: {
          'access-control-allow-origin': new URL(WEB_SIGNED_IN_URL).origin,
          'retry-after': '61',
        },
        body: JSON.stringify({
          type: 'about:blank',
          title: 'Service restarting',
          status: 503,
          code: 'service_restarting',
          restartingSince: '2026-11-07T12:00:00.000Z',
          retryAfterSeconds: 61,
        }),
      });
    },
  );
  const notice = page.locator('[data-restarting-notice]');
  const heart = page.getByRole('button', {
    name: `Favourite: Heart test story (${project})`,
  });

  await page.goto(`${WEB_SIGNED_IN_URL}/stories?theme=heart_test`);
  await expect(heart).toHaveAttribute('data-heart-state', 'off');
  await heart.click();
  await expect(notice).toHaveText(
    'Our compute is currently restarting. Please try again in about 2 minutes.',
  );
  // Trying again succeeds: the notice goes.
  await heart.click();
  await expect(heart).toHaveAttribute('aria-pressed', 'true');
  await expect(notice).toHaveCount(0);

  restarting = true;
  await heart.click();
  await expect(notice).toBeVisible();
  // Moving on in the browser keeps it until that page's own call to api-user succeeds.
  const loaded = page.waitForResponse(
    (r) =>
      r.url().startsWith(`${STUB_USER_URL}/v1/account/favourites?limit=`) &&
      r.request().method() === 'GET',
  );
  await page.getByRole('button', { name: /^Account: / }).click();
  await page.getByRole('link', { name: 'My favourites' }).click();
  expect((await loaded).status()).toBe(200);
  await expect(page).toHaveURL(`${WEB_SIGNED_IN_URL}/favourites`);
  await expect(notice).toHaveCount(0);
});
