import { expect, test } from '@playwright/test';
import { BEHAVIOUR_DEVICES } from './devices';
import { expectAllTargets, expectNoHorizontalOverflow, shots } from './helpers';

// The sign-in page (task 2.1). Clerk's own sign-in loads from Clerk's servers, so this suite
// (no network, T4) shows the E2E_FIXTURES stand-in in its place; the real one, and signing in,
// are checked on dev (apps/dev-seed/behavioural). Here: the page fits every device in both
// schemes, and the header's Sign in brings people back to the page they were on.
// The stand-in has nothing to press, so `expectAllTargets` here can't see Clerk's buttons and
// fields: clerk.behaviour.ts measures those (44 px) on the real card.

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} scheme`, () => {
    test.use({ colorScheme: scheme });

    test('the sign-in page fits, with room for Clerk’s sign-in', async ({
      page,
    }, info) => {
      await page.goto('/sign-in?redirect_url=%2Fstories');
      await expect(
        page.getByRole('heading', { level: 1, name: 'Welcome' }),
      ).toBeVisible();
      // Clerk's step titles are hidden there, so the page names the form.
      await expect(
        page.getByRole('region', { name: 'Sign in or create an account' }),
      ).toBeVisible();
      const slot = page.locator('[data-sign-in-fixture]');
      await expect(slot).toBeVisible();
      await expect(slot).toHaveAttribute('data-return-to', '/stories');
      // Clerk's card fits the column: the column is never wider than the screen.
      const box = await slot.boundingBox();
      const width = page.viewportSize()?.width ?? 0;
      expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
      await expectNoHorizontalOverflow(page);
      await expectAllTargets(page);
      await shots(page, info.project.name, scheme, 'sign-in');
    });
  });
}

test.describe('returning to the page', () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, info) => {
    test.skip(
      !BEHAVIOUR_DEVICES.includes(info.project.name),
      'one phone and one desktop',
    );
  });

  test('Sign in in the header leads to sign-in, set to return to this page', async ({
    page,
  }) => {
    await page.goto('/stories?tag=healing');
    await page.getByRole('link', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/sign-in\?redirect_url=/);
    await expect(page.locator('[data-sign-in-fixture]')).toHaveAttribute(
      'data-return-to',
      '/stories?tag=healing',
    );
  });

  test('never returns to another site', async ({ page }) => {
    for (const target of [
      'https://example.com/',
      '//example.com/x',
      '/.//example.com',
    ]) {
      await page.goto(`/sign-in?redirect_url=${encodeURIComponent(target)}`);
      await expect(page.locator('[data-sign-in-fixture]')).toHaveAttribute(
        'data-return-to',
        '/',
      );
    }
  });

  // Chromium with JavaScript turned off by Playwright still parses <noscript> as script-on,
  // so the message is checked in the page as the server sends it.
  test('without JavaScript, the page says signing in needs it', async ({
    request,
  }) => {
    const html = await (await request.get('/sign-in')).text();
    expect(html).toMatch(
      /<noscript>[^]*?Signing in needs JavaScript[^]*?<\/noscript>/,
    );
  });
});
