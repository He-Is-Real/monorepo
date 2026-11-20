import { randomUUID } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';
import { BEHAVIOUR_DEVICES } from './devices';
import { expectAllTargets, expectNoHorizontalOverflow } from './helpers';
import { WEB_SIGNED_IN_URL } from './servers';

// /admin (Joel, 2026-11-20): where the site navigation's "Admin" link leads. The shared admin
// header with the staff menu for the person's role and no page in it current, the title "Admin"
// and a one-line description, and nothing else. For Moderators and up; anyone else gets the
// moderation pages' refusal. The page fits every device; the behaviour runs on one phone and one
// desktop. The stub api-user (stub-api-user.mjs) makes sessions starting `admin` Admins and
// `moderator` Moderators; everyone else is a User.

async function useSession(page: Page, session: string) {
  await page.addInitScript(
    (s) => window.localStorage.setItem('e2e-session', s),
    session,
  );
}
const menu = (page: Page) =>
  page.getByRole('navigation', { name: 'Admin pages' });

test('/admin fits with 44 px targets', async ({ page }) => {
  await useSession(page, `admin-${randomUUID().slice(0, 8)}`);
  await page.goto(`${WEB_SIGNED_IN_URL}/admin`);
  await expect(menu(page).getByRole('link', { name: 'Staff' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectAllTargets(page);
});

test.describe('/admin', () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, info) => {
    test.skip(
      !BEHAVIOUR_DEVICES.includes(info.project.name),
      'one phone and one desktop',
    );
  });

  test('an admin sees every staff page in the menu, none of them current, and nothing else', async ({
    page,
  }) => {
    await useSession(page, `admin-${randomUUID().slice(0, 8)}`);
    await page.goto(`${WEB_SIGNED_IN_URL}/admin`);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Admin' }),
    ).toBeVisible();
    await expect(menu(page).getByRole('link')).toHaveText([
      'Moderation',
      'Consent & legal',
      'Submission limits',
      'Themes',
      'Staff',
      'Block list',
    ]);
    await expect(menu(page).locator('[aria-current]')).toHaveCount(0);
    await expect(
      page.locator('[data-admin-content] > :not(noscript)'),
    ).toHaveCount(0);
    await expect(page.locator('[data-admin-refused]')).toHaveCount(0);

    // The menu opens the staff pages.
    await menu(page).getByRole('link', { name: 'Themes' }).click();
    await expect(page).toHaveURL(/\/admin\/themes$/);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Themes' }),
    ).toBeVisible();
  });

  test('a moderator sees Moderation only, not current', async ({ page }) => {
    await useSession(page, `moderator-${randomUUID().slice(0, 8)}`);
    await page.goto(`${WEB_SIGNED_IN_URL}/admin`);
    await expect(menu(page).getByRole('link')).toHaveText(['Moderation']);
    await expect(menu(page).locator('[aria-current]')).toHaveCount(0);
    await expect(page.locator('[data-admin-refused]')).toHaveCount(0);
  });

  test('a signed-in user is refused and has no menu', async ({ page }) => {
    await useSession(page, 'user-not-staff');
    await page.goto(`${WEB_SIGNED_IN_URL}/admin`);
    await expect(page.locator('[data-admin-refused]')).toHaveText(
      'This page is for moderators.',
    );
    await expect(menu(page).getByRole('link')).toHaveCount(0);
  });

  test('a signed-out visitor is asked to sign in', async ({ page }) => {
    await page.goto('/admin');
    await expect(page.locator('[data-admin-refused]')).toHaveText(
      'Sign in with a moderator account to use this page.',
    );
    await expect(menu(page).getByRole('link')).toHaveCount(0);
  });
});
