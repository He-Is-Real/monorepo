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
    // Our page's JavaScript fails in the browser: the stories' layout can't watch its size.
    await page.addInitScript(() => {
      window.ResizeObserver = class {
        constructor() {
          throw new Error('e2e: a crash in the page');
        }
      } as unknown as typeof ResizeObserver;
    });
    await page.goto(`${WEB_SIGNED_IN_URL}/stories`);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Something went wrong' }),
    ).toBeVisible();
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
});
