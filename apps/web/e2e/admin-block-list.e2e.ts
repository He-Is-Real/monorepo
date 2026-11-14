import { randomUUID } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';
import { BEHAVIOUR_DEVICES } from './devices';
import { expectAllTargets, expectNoHorizontalOverflow } from './helpers';
import { WEB_SIGNED_IN_URL } from './servers';

// /admin/block-list (G21 D, G24; Joel 2026-11-11): an Admin sees the blocked emails and IP
// addresses, blocks an email and an address and unblocks them; Moderators are refused. The page
// fits every device; the behaviour runs on one phone and one desktop. The stub api-admin
// (stub-api-user.mjs) keeps each test's list apart by its session.

async function useSession(page: Page, session: string) {
  await page.addInitScript(
    (s) => window.localStorage.setItem('e2e-session', s),
    session,
  );
}
const admin = () => `admin-${randomUUID().slice(0, 8)}`;
const entry = (page: Page, value: string) =>
  page.locator(`[data-blocked="${value}"]`);
const status = (page: Page, kind: 'done' | 'error') =>
  page.locator(`[data-block-status="${kind}"]`);

test('/admin/block-list fits with 44 px targets', async ({ page }) => {
  await useSession(page, admin());
  await page.goto(`${WEB_SIGNED_IN_URL}/admin/block-list`);
  await expect(entry(page, 'spammer@example.com')).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectAllTargets(page);
});

test.describe('/admin/block-list', () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, info) => {
    test.skip(
      !BEHAVIOUR_DEVICES.includes(info.project.name),
      'one phone and one desktop',
    );
  });

  test('an admin blocks an email and an IP address, then unblocks them', async ({
    page,
  }) => {
    await useSession(page, admin());
    await page.goto(`${WEB_SIGNED_IN_URL}/admin/block-list`);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Block list' }),
    ).toBeVisible();
    await expect(page.getByRole('main')).toContainText(
      'A block stays until you remove it, even if the account is deleted.',
    );
    await expect(entry(page, 'spammer@example.com')).toContainText(
      'Blocked by joel@heisreal.today on 11 November 2026.',
    );
    await expect(page.getByText('No IP addresses are blocked.')).toBeVisible();

    const emails = page.getByRole('region', { name: 'Emails' });
    await emails
      .getByLabel('Email', { exact: true })
      .fill('Abuser@Example.com');
    await emails.getByRole('button', { name: 'Block', exact: true }).click();
    await expect(status(page, 'done')).toHaveText(
      'Abuser@Example.com is blocked.',
    );
    await expect(entry(page, 'abuser@example.com')).toContainText(
      'Blocked by e2e-admin@heisreal.today',
    );
    await expect(emails.getByLabel('Email', { exact: true })).toHaveValue('');

    // Not an address: refused, nothing added.
    const ips = page.getByRole('region', { name: 'IP addresses' });
    await ips.getByLabel('IP address', { exact: true }).fill('not an address');
    await ips.getByRole('button', { name: 'Block', exact: true }).click();
    await expect(status(page, 'error')).toHaveText(
      'Enter an IP address, like 203.0.113.7 or 2001:db8::1.',
    );
    await ips
      .getByLabel('IP address', { exact: true })
      .fill('2001:DB8:0:0:0:0:0:1');
    await ips.getByRole('button', { name: 'Block', exact: true }).click();
    await expect(entry(page, '2001:db8::1')).toBeVisible();

    await page.reload();
    await expect(entry(page, 'abuser@example.com')).toBeVisible();
    await page
      .getByRole('button', { name: 'Unblock abuser@example.com' })
      .click();
    await expect(status(page, 'done')).toHaveText(
      'abuser@example.com is no longer blocked.',
    );
    await expect(entry(page, 'abuser@example.com')).toHaveCount(0);
    await page.getByRole('button', { name: 'Unblock 2001:db8::1' }).click();
    await expect(entry(page, '2001:db8::1')).toHaveCount(0);
  });

  test('is for admins only: a moderator is refused and has no link to it', async ({
    page,
  }) => {
    await useSession(page, `moderator-${randomUUID().slice(0, 8)}`);
    await page.goto(`${WEB_SIGNED_IN_URL}/admin/block-list`);
    await expect(page.locator('[data-admin-refused]')).toHaveText(
      'This page is for admins.',
    );
    await expect(entry(page, 'spammer@example.com')).toHaveCount(0);
    const nav = page.getByRole('navigation', { name: 'Admin pages' });
    await expect(nav.getByRole('link')).toHaveText(['Moderation']);
  });
});
