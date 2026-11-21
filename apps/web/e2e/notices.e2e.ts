import { randomUUID } from 'node:crypto';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { BEHAVIOUR_DEVICES } from './devices';
import { enlargeText, expectNoHorizontalOverflow } from './helpers';
import { STUB_USER_URL, WEB_DOWN_URL, WEB_SIGNED_IN_URL } from './servers';

// The site's notices (NT-1 A1, Joel, 21 November 2026) are one library piece in four kinds. What
// screen readers hear is the behaviour: a notice keeps the role it had before the new look, so
// errors interrupt (alert) and news waits its turn (status), and a live region that announces
// later is in the page before its words arrive.

// eslint-disable-next-line no-empty-pattern
test.beforeEach(({}, info) => {
  test.skip(
    !BEHAVIOUR_DEVICES.includes(info.project.name),
    'one phone and one desktop',
  );
});

async function useSession(page: Page, session: string) {
  await page.addInitScript(
    (s) => window.localStorage.setItem('e2e-session', s),
    session,
  );
}

test('Submission limits: "Saved" is a status, and a page that can’t load is an alert', async ({
  page,
}) => {
  await useSession(page, `admin-${randomUUID().slice(0, 8)}`);
  await page.goto(`${WEB_SIGNED_IN_URL}/admin/limits`);
  const box = page.locator('[data-limit] input').first();
  await expect(box).toBeVisible();
  await box.fill(String(Number(await box.inputValue()) + 1));
  await page.locator('[data-save-bar] button[type=submit]').click();
  await page.getByRole('button', { name: 'Yes, save' }).click();
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: 'Saved. The new limits apply now.' }),
  ).toBeVisible();

  await page.route('**/v1/admin/submission-settings', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({
          status: 500,
          contentType: 'application/problem+json',
          body: JSON.stringify({
            type: 'about:blank',
            title: 'Internal Server Error',
            status: 500,
            code: 'something_internal',
          }),
        })
      : route.continue(),
  );
  await page.reload();
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: 'Something went wrong. Please try again later.' }),
  ).toBeVisible();
});

test('home and browse say "try again later" as a status, not an alert', async ({
  page,
}) => {
  for (const path of ['/', '/stories']) {
    await page.goto(`${WEB_DOWN_URL}${path}`);
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: 'Something went wrong. Please try again later.' }),
    ).toBeVisible();
    await expect(
      page.getByRole('alert').filter({ hasText: 'try again later' }),
    ).toHaveCount(0);
  }
});

test('My submissions: the status region is there before a delete, and announces it', async ({
  page,
  request,
}) => {
  const id = randomUUID().replace(/-/g, '');
  const res = await request.post(`${STUB_USER_URL}/__e2e/sessions/${id}`, {
    data: { stories: [{ id: 'n1', title: 'Delete me' }] },
  });
  expect(res.status()).toBe(204);
  await useSession(page, id);
  await page.goto(`${WEB_SIGNED_IN_URL}/account`);
  const region = page.locator('[data-notice]');
  // In the page, empty, before anything happens: a region added with its words isn't read.
  await expect(region).toHaveAttribute('role', 'status');
  await expect(region).toBeEmpty();
  const card = page.locator('[data-submission]');
  await card.getByRole('button', { name: 'Delete', exact: true }).click();
  await card.getByRole('button', { name: 'Delete draft' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: '“Delete me” is deleted.' }),
  ).toBeVisible();
});

test('the owner’s preview: a story that can’t load is an alert', async ({
  page,
  request,
}) => {
  const id = randomUUID().replace(/-/g, '');
  const res = await request.post(`${STUB_USER_URL}/__e2e/sessions/${id}`, {
    data: { stories: [{ id: 'p1', title: 'My draft' }] },
  });
  expect(res.status()).toBe(204);
  await useSession(page, id);
  await page.route('**/v1/account/stories/p1', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({
          status: 500,
          contentType: 'application/problem+json',
          body: JSON.stringify({
            type: 'about:blank',
            title: 'Internal Server Error',
            status: 500,
            code: 'something_internal',
          }),
        })
      : route.continue(),
  );
  await page.goto(`${WEB_SIGNED_IN_URL}/account/stories/p1/preview`);
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: 'Something went wrong. Please try again later.' }),
  ).toBeVisible();
});

/** A button's words wrap only between words: never more lines than words (a letter a line). */
async function expectWholeWords(button: Locator) {
  await expect(button).toBeVisible();
  const { lines, words } = await button.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const tops = new Set(
      [...range.getClientRects()]
        .filter((r) => r.width > 0)
        .map((r) => Math.round(r.top)),
    );
    return {
      lines: tops.size,
      words: (el.textContent ?? '').trim().split(/\s+/).length,
    };
  });
  expect(
    lines,
    `“${await button.innerText()}” breaks inside a word`,
  ).toBeLessThanOrEqual(words);
}

test.describe('at 200% text on a 320 px phone, buttons in notices keep whole words', () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, info) => {
    test.skip(info.project.name !== 'phone-320', 'the smallest phone');
  });

  test('Share’s load error', async ({ page, request }) => {
    await enlargeText(page);
    const id = randomUUID().replace(/-/g, '');
    const res = await request.post(`${STUB_USER_URL}/__e2e/sessions/${id}`, {
      data: { testimony: 3 },
    });
    expect(res.status()).toBe(204);
    await useSession(page, id);
    await page.route('**/v1/account', (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({ status: 500, json: { status: 500 } })
        : route.continue(),
    );
    await page.goto(`${WEB_SIGNED_IN_URL}/share`);
    await expectWholeWords(
      page.locator('[data-slot="notice"]').getByRole('button', {
        name: 'Try again',
      }),
    );
    await expectNoHorizontalOverflow(page);
  });

  test('the changed testimony consent banner', async ({ page, request }) => {
    await enlargeText(page);
    const id = randomUUID().replace(/-/g, '');
    const res = await request.post(`${STUB_USER_URL}/__e2e/sessions/${id}`, {
      data: { testimony: 1 },
    });
    expect(res.status()).toBe(204);
    await useSession(page, id);
    await page.goto(`${WEB_SIGNED_IN_URL}/about`);
    const banner = page.locator('[data-consent-banner]');
    await expectWholeWords(
      banner.getByRole('link', { name: 'Read what’s changed' }),
    );
    await expectWholeWords(banner.getByRole('button', { name: 'Not now' }));
    await expectNoHorizontalOverflow(page);
  });

  test('a review page that changed while open', async ({ page }) => {
    await enlargeText(page);
    await useSession(page, 'moderator-notice-zoom');
    await page.goto(`${WEB_SIGNED_IN_URL}/moderation/mod_video`);
    await expect(page.locator('[data-review-status]')).toBeVisible();
    await page.route('**/v1/moderation/stories/mod_video', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch({
        headers: { ...route.request().headers(), 'if-none-match': '' },
      });
      const body = await response.json();
      body.version += 1;
      body.status = 'editing';
      return route.fulfill({ response, json: body });
    });
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expectWholeWords(
      page
        .locator('[data-review-stale]')
        .getByRole('button', { name: 'Reload to see it' }),
    );
    await expectNoHorizontalOverflow(page);
  });
});
