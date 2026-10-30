import { expect, test } from '@playwright/test';
import { expectClerkTargetsFullSize, expectFitsScreen } from './clerk-card';

// Signing in on the deployed dev site with the real Clerk dev instance (the test user lands on
// the sign-up consent step, D73, without ticking it), then the browser's
// real cross-origin call to api-user: the account bootstrap (M2), with the person's session
// token (Clerk's RS256, `azp` = web's origin), allowed by api-user's CORS (D31).
//
// Needs (README, "Dev behavioural tests"):
// - api-user on Cloud Run with web's origins in CORS_ALLOWED_ORIGINS and
//   CLERK_AUTHORIZED_PARTIES, and web's API_USER_URL (OpenTofu);
// - the Clerk test user below, created once on the dev instance. A `+clerk_test` address
//   gets no email: Clerk's development instances accept the fixed code 424242 for it.
const TEST_USER = 'behavioural+clerk_test@example.com';
const TEST_CODE = '424242';

for (const viewport of [
  { width: 320, height: 568 },
  { width: 1280, height: 800 },
]) {
  test(`${viewport.width} px: a Clerk test user signs in, returns to the page, and api-user knows them`, async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize(viewport);
    const web = new URL(baseURL ?? '').origin;
    await page.goto('/about');
    await page.getByRole('link', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/sign-in\?redirect_url=%2Fabout/);

    await page.getByLabel(/email address/i).fill(TEST_USER);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    // Email code (D2): the code boxes take the fixed test code.
    await expect(page.getByText(/check your email for a code/i)).toBeVisible();
    await expect(page.getByLabel(/verification code/i)).toBeVisible();
    // The code step's controls (Edit, the code, Resend, another method) are full size too, and
    // the page's "Welcome" stays its only h1.
    await expectClerkTargetsFullSize(page);
    await expectFitsScreen(page, viewport.width);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText([
      'Welcome',
    ]);
    const bootstrap = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === '/v1/account' &&
        r.request().method() === 'GET',
      { timeout: 45_000 },
    );
    await page.keyboard.type(TEST_CODE);

    // The step follows api-user's answer, which can take a while from a cold start.
    const response = await bootstrap;
    // Signed in. The test user never accepts the sign-up form, so the header sends them to
    // the sign-up consent step (D73), set to return to where they started; its boxes are
    // left unticked, so every run sees the same.
    await expect(page).toHaveURL(
      `${web}/consent/sign-up?redirect_url=%2Fabout`,
    );
    await expect(
      page.getByRole('button', { name: /^Account: / }),
    ).toBeVisible();
    await expect(page.getByRole('checkbox')).toHaveCount(2);
    for (const box of await page.getByRole('checkbox').all()) {
      await expect(box).not.toBeChecked();
    }

    expect(new URL(response.url()).origin).not.toBe(web);
    expect(response.request().headers()['authorization']).toMatch(/^Bearer ey/);
    expect(response.status()).toBe(200);
    expect(response.headers()['access-control-allow-origin']).toBe(web);
    expect(await response.json()).toMatchObject({
      role: 'User',
      version: null,
      signupConsent: { accepted: false },
      testimonyConsent: { acceptanceRequired: false },
    });

    // One Clerk session for the whole page (D115): the consent form sees the person the header
    // shows, so it can be agreed to, not "You're signed out".
    await expect(
      page.getByRole('button', { name: 'Agree and continue' }),
    ).toBeEnabled();
    await expect(page.getByText('You’re signed out.')).toHaveCount(0);

    // Signing out from the form goes home, signed out, and the next page load forgets what the
    // submit flow kept in the tab (account-control.tsx).
    await page.evaluate(() =>
      sessionStorage.setItem('heisreal:share:user_x:new', '{}'),
    );
    await page
      .getByRole('main')
      .getByRole('button', { name: 'Sign out' })
      .click();
    await expect(page).toHaveURL(`${web}/`);
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() =>
          Object.keys(sessionStorage).filter((k) =>
            k.startsWith('heisreal:share:'),
          ),
        ),
      )
      .toEqual([]);
  });
}
