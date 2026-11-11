import { randomUUID } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';
import { BEHAVIOUR_DEVICES } from './devices';
import { expectAllTargets, expectNoHorizontalOverflow } from './helpers';
import { WEB_SIGNED_IN_URL } from './servers';

// /admin/staff (S-1 to S-4, G7, G8 B, G24; Joel 2026-11-11): an Admin sees the staff list, adds an
// @heisreal.today email as a Moderator, makes them an Admin and removes them; the last Admin can't
// be removed. Moderators see only Moderation; every other staff page is for Admins. The page fits
// every device; the behaviour runs on one phone and one desktop. The stub api-admin
// (stub-api-user.mjs) keeps each test's list apart by its session.

async function useSession(page: Page, session: string) {
  await page.addInitScript(
    (s) => window.localStorage.setItem('e2e-session', s),
    session,
  );
}
const admin = () => `admin-${randomUUID().slice(0, 8)}`;
const member = (page: Page, email: string) =>
  page.locator(`[data-staff-member="${email}"]`);

test('/admin/staff fits with 44 px targets', async ({ page }) => {
  await useSession(page, admin());
  await page.goto(`${WEB_SIGNED_IN_URL}/admin/staff`);
  await expect(member(page, 'joel@heisreal.today')).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectAllTargets(page);
});

test.describe('/admin/staff', () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, info) => {
    test.skip(
      !BEHAVIOUR_DEVICES.includes(info.project.name),
      'one phone and one desktop',
    );
  });

  test('an admin adds someone as a Moderator, makes them an Admin, then removes them', async ({
    page,
  }) => {
    await useSession(page, admin());
    await page.goto(`${WEB_SIGNED_IN_URL}/admin/staff`);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Staff' }),
    ).toBeVisible();
    await expect(page.getByRole('main')).toContainText(
      'A change takes effect within about a minute',
    );
    await expect(page.getByRole('main')).toContainText(
      'Baseline admins come back as admins on the next deploy',
    );
    await expect(member(page, 'joel@heisreal.today')).toContainText(
      'Baseline admin. Added by the deploy',
    );

    // Only @heisreal.today: refused on the page, nothing added.
    await page.getByLabel('Email').fill('ann@example.com');
    await page.getByRole('button', { name: 'Add' }).click();
    await expect(
      page.getByText('Enter an @heisreal.today email address.'),
    ).toBeVisible();
    await expect(member(page, 'ann@example.com')).toHaveCount(0);

    // S-7: no account with that email yet, so nothing is added.
    await page.getByLabel('Email').fill('nobody@heisreal.today');
    await page.getByRole('button', { name: 'Add' }).click();
    await expect(page.locator('[data-staff-status="error"]')).toHaveText(
      'Ask them to create an account first, then add them.',
    );
    await expect(member(page, 'nobody@heisreal.today')).toHaveCount(0);

    await page.getByLabel('Email').fill('Ann@heisreal.today');
    await page
      .getByRole('combobox', { name: 'Role', exact: true })
      .selectOption('Moderator');
    await page.getByRole('button', { name: 'Add' }).click();
    await expect(page.locator('[data-staff-status="done"]')).toHaveText(
      'ann@heisreal.today is now a Moderator.',
    );
    const ann = member(page, 'ann@heisreal.today');
    await expect(ann).toContainText('Added by e2e-admin@heisreal.today');
    const role = page.getByLabel('Role for ann@heisreal.today');
    await expect(role).toHaveValue('Moderator');

    await role.selectOption('Admin');
    await expect(page.locator('[data-staff-status="done"]')).toHaveText(
      'ann@heisreal.today is now an Admin.',
    );
    await page.reload();
    await expect(page.getByLabel('Role for ann@heisreal.today')).toHaveValue(
      'Admin',
    );

    await page
      .getByRole('button', { name: 'Remove ann@heisreal.today' })
      .click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toContainText(
      'Remove ann@heisreal.today from the staff? They become a User.',
    );
    await confirm.getByRole('button', { name: 'Yes, remove' }).click();
    await expect(page.locator('[data-staff-status="done"]')).toHaveText(
      'ann@heisreal.today is no longer staff.',
    );
    await expect(member(page, 'ann@heisreal.today')).toHaveCount(0);
  });

  test('the last Admin can’t be removed', async ({ page }) => {
    await useSession(page, admin());
    await page.goto(`${WEB_SIGNED_IN_URL}/admin/staff`);
    const remove = async (email: string) => {
      await page.getByRole('button', { name: `Remove ${email}` }).click();
      await page
        .getByRole('alertdialog')
        .getByRole('button', { name: 'Yes, remove' })
        .click();
    };
    await remove('info@heisreal.today');
    await expect(member(page, 'info@heisreal.today')).toHaveCount(0);
    await remove('joel@heisreal.today');
    await expect(page.locator('[data-staff-status="error"]')).toHaveText(
      'There must always be at least one admin. Make someone else an admin first.',
    );
    await expect(member(page, 'joel@heisreal.today')).toBeVisible();
  });

  test('a Moderator sees only Moderation; themes, limits, legal texts and staff are for Admins', async ({
    page,
  }) => {
    await useSession(page, `moderator-${randomUUID().slice(0, 8)}`);
    for (const path of [
      '/admin/themes',
      '/admin/limits',
      '/admin/consent',
      '/admin/staff',
    ]) {
      await page.goto(`${WEB_SIGNED_IN_URL}${path}`);
      await expect(page.locator('[data-admin-refused]'), path).toHaveText(
        'This page is for admins.',
      );
    }
    const nav = page.getByRole('navigation', { name: 'Admin pages' });
    await expect(nav.getByRole('link')).toHaveText(['Moderation']);
    await expect(member(page, 'joel@heisreal.today')).toHaveCount(0);
  });
});
