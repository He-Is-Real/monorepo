import { expect, type Page, type Request, test } from '@playwright/test';
import { BEHAVIOUR_DEVICES } from './devices';
import { SIGNED_IN_NAME, STUB_USER_URL, WEB_SIGNED_IN_URL } from './servers';

// The account bootstrap (M2): once a page loads signed in, the browser calls api-user's
// `GET /v1/account` once, cross-origin with the person's token (here the fixtures' token, to
// the stub api-user, which allows web's origin only, like the real one). If api-user is down
// or unreachable, nothing is blocked: the header and pages work as before. One phone and one
// desktop: none of this depends on the screen.

// eslint-disable-next-line no-empty-pattern
test.beforeEach(({}, info) => {
  test.skip(
    !BEHAVIOUR_DEVICES.includes(info.project.name),
    'one phone and one desktop',
  );
});

const ACCOUNT_URL = `${STUB_USER_URL}/v1/account`;
const isBootstrap = (r: Request) =>
  r.url() === ACCOUNT_URL && r.method() === 'GET';

/** The account control, after a click on it has been handled (React has run every effect). */
async function openAccount(page: Page) {
  const account = page.getByRole('button', {
    name: `Account: ${SIGNED_IN_NAME}`,
  });
  await account.click();
  await expect(page.getByRole('dialog')).toContainText(
    `Signed in as ${SIGNED_IN_NAME}`,
  );
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

test('signed in, the header calls the account bootstrap once per page load', async ({
  page,
}) => {
  const calls: Request[] = [];
  page.on('request', (r) => {
    if (isBootstrap(r)) calls.push(r);
  });
  const answered = page.waitForResponse((r) => isBootstrap(r.request()));
  await page.goto(`${WEB_SIGNED_IN_URL}/about`);
  const response = await answered;
  expect(response.status()).toBe(200);
  expect(response.request().headers()['authorization']).toMatch(/^Bearer /);
  expect((await response.json()).role).toBe('User');

  // Re-rendering the header and moving to another page in the app keep it at one call.
  await openAccount(page);
  await page.getByRole('link', { name: 'He Is Real Today, home' }).click();
  await expect(page).toHaveURL(`${WEB_SIGNED_IN_URL}/`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await openAccount(page);
  expect(calls).toHaveLength(1);

  // A new page load asks again.
  const again = page.waitForResponse((r) => isBootstrap(r.request()));
  await page.reload();
  expect((await again).status()).toBe(200);
  await openAccount(page);
  expect(calls).toHaveLength(2);
});

for (const [outage, answer] of [
  ['answers 503', { status: 503, title: 'Service unavailable' } as const],
  ['can’t be reached', null],
] as const) {
  test(`when api-user ${outage}, the header and pages still work`, async ({
    page,
  }) => {
    const origin = new URL(WEB_SIGNED_IN_URL).origin;
    let tried = false;
    await page.route(ACCOUNT_URL, async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      tried = true;
      if (!answer) return route.abort('connectionrefused');
      return route.fulfill({
        status: answer.status,
        contentType: 'application/problem+json',
        headers: { 'access-control-allow-origin': origin },
        body: JSON.stringify({ type: 'about:blank', ...answer }),
      });
    });
    await page.goto(`${WEB_SIGNED_IN_URL}/stories`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await openAccount(page);
    expect(tried, 'the bootstrap was attempted').toBe(true);
    // Nothing says something went wrong, and the site carries on as usual.
    await expect(page.getByText(/something went wrong/i)).toHaveCount(0);
    await page.getByRole('link', { name: 'He Is Real Today, home' }).click();
    await expect(page).toHaveURL(`${WEB_SIGNED_IN_URL}/`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await openAccount(page);
  });
}
