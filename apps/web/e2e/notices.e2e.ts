import { randomUUID } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';
import { BEHAVIOUR_DEVICES } from './devices';
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
