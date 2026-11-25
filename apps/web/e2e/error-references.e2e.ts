import { expect, type Page, test } from '@playwright/test';
import { BEHAVIOUR_DEVICES } from './devices';
import { expectNoHorizontalOverflow, expectTarget } from './helpers';
import { STUB_USER_URL, WEB_SIGNED_IN_URL } from './servers';

// Every error people see has a reference under it (LG-1, LG-1b A; Joel 22 Nov 2026: "every error
// must have a reference and reference be unique"): "Reference: <a UUID v7>" with a Copy button,
// no codes. A page crash in the browser also sends api-user a small report with that reference
// (LG-1c). The error page's line is checked on every device; the rest runs on one phone and one
// desktop.

const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function shownReference(page: Page): Promise<string> {
  const line = page.locator('main [data-reference]');
  await expect(line).toBeVisible();
  await expect(line).toContainText('Reference:');
  const value = (
    await line.locator('[data-reference-value]').textContent()
  )?.trim();
  expect(value).toMatch(UUID_V7);
  return value ?? '';
}

/**
 * Our page's JavaScript fails in the browser: the stories' layout can't watch its size. `once`:
 * only on the tab's first load (a reload works).
 */
async function crashInThePage(page: Page, once = false): Promise<void> {
  await page.addInitScript((onlyOnce) => {
    if (onlyOnce) {
      if (sessionStorage.getItem('e2e-crashed')) return;
      sessionStorage.setItem('e2e-crashed', '1');
    }
    window.ResizeObserver = class {
      constructor() {
        throw new Error('e2e: a crash in the page');
      }
    } as unknown as typeof ResizeObserver;
  }, once);
}

/** api-user's list of the person's stories gets no answer the first time it is asked. */
async function firstListGetsNoAnswer(page: Page): Promise<void> {
  let asked = 0;
  await page.route(`${STUB_USER_URL}/v1/account/stories*`, (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    asked += 1;
    return asked === 1 ? route.abort('internetdisconnected') : route.fallback();
  });
}

const NO_ANSWER =
  'We couldn’t reach He Is Real. Check your internet connection and try again.';

// The story page's outage and restart messages are checked on every device in responsive.e2e.ts.
test('the site’s error page shows its reference on every device', async ({
  page,
}) => {
  await page.goto('/something-went-wrong');
  await shownReference(page);
  await expectTarget(
    page,
    page.getByRole('button', { name: 'Copy the reference' }),
  );
  await expectNoHorizontalOverflow(page);
});

// LG-13c (Joel, 25 Nov 2026): a message fitting the error where it isn't sensitive.
test('a crash in the page fits the screen on every device', async ({
  page,
}) => {
  await crashInThePage(page);
  await page.goto(`${WEB_SIGNED_IN_URL}/stories`);
  await expect(
    page.getByRole('heading', { level: 1, name: 'This page stopped working' }),
  ).toBeVisible();
  await shownReference(page);
  await expectTarget(page, page.getByRole('button', { name: 'Reload page' }));
  await expectTarget(
    page,
    page.getByRole('link', { name: 'Go to the home page' }),
  );
  await expectNoHorizontalOverflow(page);
});

test('“We couldn’t reach He Is Real” fits the screen on every device', async ({
  page,
}) => {
  await firstListGetsNoAnswer(page);
  await page.goto(`${WEB_SIGNED_IN_URL}/account`);
  await expect(page.getByText(NO_ANSWER)).toBeVisible();
  await shownReference(page);
  await expectTarget(page, page.getByRole('button', { name: 'Try again' }));
  await expectNoHorizontalOverflow(page);
});

test.describe('behaviour', () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, info) => {
    test.skip(
      !BEHAVIOUR_DEVICES.includes(info.project.name),
      'one phone and one desktop',
    );
  });

  test('every error gets its own reference', async ({ page }) => {
    await page.goto('/stories/down');
    const first = await shownReference(page);
    await page.reload();
    await expect.poll(() => shownReference(page)).not.toBe(first);
  });

  test('a crash in the page is reported with the reference it shows', async ({
    page,
  }) => {
    await crashInThePage(page);
    await page.goto(`${WEB_SIGNED_IN_URL}/stories`);
    await expect(
      page.getByRole('heading', {
        level: 1,
        name: 'This page stopped working',
      }),
    ).toBeVisible();
    await expect(
      page.getByText('Reloading it usually fixes this.'),
    ).toBeVisible();
    await expect(page.getByText(/something went wrong/i)).toHaveCount(0);
    const reference = await shownReference(page);
    await expect
      .poll(async () => {
        const res = await page.request.get(
          `${STUB_USER_URL}/__e2e/error-reports`,
        );
        const { reports } = (await res.json()) as {
          reports: { reference: string; route: string; kind: string }[];
        };
        return reports.find((r) => r.reference === reference);
      })
      .toEqual({ reference, route: '/stories', kind: 'browser_crash' });
  });

  test('Reload page after a crash loads the page again', async ({ page }) => {
    await crashInThePage(page, true);
    await page.goto(`${WEB_SIGNED_IN_URL}/stories`);
    const crashed = page.getByRole('heading', {
      level: 1,
      name: 'This page stopped working',
    });
    await expect(crashed).toBeVisible();
    await page.getByRole('button', { name: 'Reload page' }).click();
    await expect(page).toHaveURL(`${WEB_SIGNED_IN_URL}/stories`);
    await expect(page.locator('main article').first()).toBeVisible();
    await expect(crashed).toHaveCount(0);
  });

  test('no answer: it says so, Try again loads it, and it is reported with its reference', async ({
    page,
  }) => {
    await firstListGetsNoAnswer(page);
    await page.goto(`${WEB_SIGNED_IN_URL}/account`);
    const message = page.getByText(NO_ANSWER);
    await expect(message).toBeVisible();
    await expect(page.getByText(/something went wrong/i)).toHaveCount(0);
    const reference = await shownReference(page);
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(message).toHaveCount(0);
    await expect(page.locator('main [data-reference]')).toHaveCount(0);
    // The call that got through sends the waiting report (LG-9a).
    await expect
      .poll(async () => {
        const res = await page.request.get(
          `${STUB_USER_URL}/__e2e/error-reports`,
        );
        const { reports } = (await res.json()) as {
          reports: { reference: string; route: string; kind: string }[];
        };
        return reports.find((r) => r.reference === reference);
      })
      .toEqual({ reference, route: '/account', kind: 'no_answer' });
  });
});
