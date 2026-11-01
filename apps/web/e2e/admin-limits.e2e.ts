import { randomUUID } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';
import { expectAllTargets, expectNoHorizontalOverflow } from './helpers';
import { WEB_SIGNED_IN_URL } from './servers';

// /admin/limits (W3, D94, D112, D113), on every device: an admin sees the limits in force in
// plain words with their units, changes one, confirms the change and it's saved; a save on
// limits another admin changed meanwhile asks to reload; anyone else is refused. The stub
// api-admin (stub-api-user.mjs) keeps each test's limits apart by its session.

async function useSession(page: Page, session: string) {
  await page.addInitScript(
    (s) => window.localStorage.setItem('e2e-session', s),
    session,
  );
}

test.describe('/admin/limits', () => {
  test('an admin changes a limit, confirms, and it is saved', async ({
    page,
  }) => {
    await useSession(page, `admin-${randomUUID().slice(0, 8)}`);
    await page.goto(`${WEB_SIGNED_IN_URL}/admin/limits`);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Submission limits' }),
    ).toBeVisible();
    // Linked from the other admin page, and back.
    await expect(
      page
        .getByRole('navigation', { name: 'Admin pages' })
        .getByRole('link', { name: 'Consent & legal' }),
    ).toHaveAttribute('href', '/admin/consent');
    // Pre-filled with what's in force, in the page's units.
    const video = page.getByLabel('Largest video file');
    await expect(video).toHaveValue('4096');
    await expect(page.getByLabel('Longest video or audio')).toHaveValue('15');
    const weekly = page.getByLabel('Stories one person can send for review');
    await expect(weekly).toHaveValue('1');
    await expectNoHorizontalOverflow(page);
    await expectAllTargets(page);

    // A value out of bounds is marked on its field, and nothing is asked.
    await video.fill('99999');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('[data-limit="videoMaxBytes"]')).toContainText(
      'Enter a whole number from 1 to 10,240 (MB).',
    );
    await expect(page.getByRole('alertdialog')).toHaveCount(0);

    await video.fill('2048');
    await weekly.fill('2');
    await page.getByRole('button', { name: 'Save' }).click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toContainText('apply to everyone');
    await expect(confirm).toContainText(
      'Largest video file: 4,096 MB → 2,048 MB',
    );
    await expect(confirm).toContainText(
      'Stories one person can send for review: 1 per 7 days → 2 per 7 days',
    );
    await expectNoHorizontalOverflow(page);
    await confirm.getByRole('button', { name: 'Yes, save' }).click();
    await expect(page.locator('[data-save-status="done"]')).toHaveText(
      'Saved. The new limits apply now.',
    );
    await page.reload();
    await expect(page.getByLabel('Largest video file')).toHaveValue('2048');
    await expect(
      page.getByLabel('Stories one person can send for review'),
    ).toHaveValue('2');
  });

  test('a stale save (another admin saved meanwhile) is refused and asks to reload', async ({
    browser,
  }) => {
    const session = `admin-${randomUUID().slice(0, 8)}`;
    const open = async () => {
      const page = await (await browser.newContext()).newPage();
      await useSession(page, session);
      await page.goto(`${WEB_SIGNED_IN_URL}/admin/limits`);
      await expect(
        page.getByLabel('Unfinished drafts one person can have'),
      ).toHaveValue('3');
      return page;
    };
    const mine = await open();
    const theirs = await open();
    for (const [page, drafts] of [
      [theirs, '4'],
      [mine, '5'],
    ] as const) {
      await page
        .getByLabel('Unfinished drafts one person can have')
        .fill(drafts);
      await page.getByRole('button', { name: 'Save' }).click();
      await page.getByRole('button', { name: 'Yes, save' }).click();
    }
    await expect(theirs.locator('[data-save-status="done"]')).toBeVisible();
    const stale = mine.locator('[data-save-status="stale"]');
    await expect(stale).toContainText('Someone else changed the limits');
    await stale.getByRole('button', { name: 'Reload' }).click();
    await expect(
      mine.getByLabel('Unfinished drafts one person can have'),
    ).toHaveValue('4');
  });

  test('only for admins: anyone else is told so and sees no limits', async ({
    page,
  }) => {
    await useSession(page, `user-${randomUUID().slice(0, 8)}`);
    await page.goto(`${WEB_SIGNED_IN_URL}/admin/limits`);
    await expect(page.locator('[data-admin-refused]')).toHaveText(
      'This page is for admins.',
    );
    await expect(page.locator('[data-limit]')).toHaveCount(0);
  });
});
