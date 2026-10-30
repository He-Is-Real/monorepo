import { randomUUID } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';
import {
  expectAllTargets,
  expectNoHorizontalOverflow,
  expectTarget,
} from './helpers';
import { STUB_USER_URL, WEB_SIGNED_IN_URL } from './servers';

// The legal documents (D121, D125; Joel, 2026-10-30: "I like the current way policy is displayed
// with site formatting, keep this and make an easy method for admins to modify and version
// this"), on every device:
// - /privacy and /terms show the version in force as Markdown in the site's own formatting
//   (inline `code` as real code), with its number, and link the earlier versions, each kept at
//   /privacy/versions/<n>;
// - the sign-up step's terms box links the terms of use in force, outside the box's own words;
// - /admin/legal, for Admins: edit the text with a live preview, confirm, publish; the new
//   version is in force and the old ones stay listed. A publish based on a version that's no
//   longer in force asks to reload. The stub api-admin (stub-api-user.mjs) keeps each test's
//   versions apart by its session.

async function useSession(page: Page, session: string) {
  await page.addInitScript(
    (s) => window.localStorage.setItem('e2e-session', s),
    session,
  );
}

test.describe('the privacy policy and terms of use pages', () => {
  test('/privacy: the version in force in the site’s formatting, inline code as code, and the earlier version', async ({
    page,
  }) => {
    await page.goto('/privacy');
    const policy = page.locator('[data-legal-version]');
    await expect(policy).toHaveAttribute('data-legal-version', '2');
    await expect(page.locator('[data-version-line]')).toContainText(
      'Version 2, published',
    );
    await expect(
      page.getByRole('heading', { level: 2, name: 'Cookies and storage' }),
    ).toBeVisible();
    // Joel's bug: text in backticks is shown as code, not as plain words.
    const code = policy.locator('code', { hasText: 'theme' }).first();
    await expect(code).toBeVisible();
    expect(
      await code.evaluate((el) => getComputedStyle(el).fontFamily),
    ).toMatch(/mono/i);

    const earlier = page.locator('[data-document-versions="privacy"] li');
    await expect(earlier).toHaveCount(1);
    const link = earlier.getByRole('link', { name: /^Version 1, published/ });
    await expect(link).toHaveAttribute('href', '/privacy/versions/1');
    await expectTarget(page, link);
    await expectNoHorizontalOverflow(page);
    await expectAllTargets(page);

    await link.click();
    await expect(page).toHaveURL(/\/privacy\/versions\/1$/);
    await expect(page.locator('[data-legal-version]')).toContainText(
      'Privacy document: development placeholder',
    );
    await expect(page.getByRole('note')).toContainText(
      'Read the current privacy policy (version 2)',
    );
    await expectNoHorizontalOverflow(page);
  });

  test('/terms: the version in force; an unknown version is a 404', async ({
    page,
  }) => {
    await page.goto('/terms');
    await expect(page.locator('[data-legal-version]')).toContainText(
      'The real terms come before the site goes live.',
    );
    // Only one version so far: no other versions listed.
    await expect(page.locator('[data-document-versions]')).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await expectAllTargets(page);
    const missing = await page.goto('/terms/versions/9');
    expect(missing?.status()).toBe(404);
  });
});

test('the sign-up step’s terms box links the terms of use in force, outside its words', async ({
  page,
}) => {
  await useSession(page, `unaccepted-${randomUUID().slice(0, 8)}`);
  await page.goto(`${WEB_SIGNED_IN_URL}/consent/sign-up`);
  const terms = page.getByRole('checkbox', {
    name: 'I agree to the terms of use.',
  });
  await expect(terms).not.toBeChecked();
  const link = page.getByRole('link', {
    name: 'Read the terms of use, version 1 (opens in a new tab)',
  });
  await expect(link).toHaveAttribute('href', '/terms/versions/1');
  await expect(link).toHaveAttribute('data-terms-version', 'dev_placeholder');
  await expectTarget(page, link);
  // The privacy policy, folded away, in the same formatting as /privacy.
  await page.getByText('Read the privacy policy', { exact: true }).click();
  const privacy = page.locator('[data-privacy-document="dev_policy"]');
  await expect(
    privacy.locator('code', { hasText: 'theme' }).first(),
  ).toBeVisible();
  await expect(
    privacy.getByRole('link', { name: /^Version 2, on its own page/ }),
  ).toHaveAttribute('href', '/privacy/versions/2');
  await expectNoHorizontalOverflow(page);
});

test.describe('/admin/legal', () => {
  test('an admin edits the privacy policy with a live preview, confirms, and publishes version 3', async ({
    page,
  }) => {
    await useSession(page, `admin-${randomUUID().slice(0, 8)}`);
    await page.goto(`${WEB_SIGNED_IN_URL}/admin/legal`);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Legal documents' }),
    ).toBeVisible();
    await expect(
      page.getByRole('radio', { name: /^Privacy policy/ }),
    ).toBeChecked();
    const versions = page.locator('[data-versions="privacy"] > li');
    await expect(versions).toHaveCount(2);
    await expect(versions.nth(0).locator('[data-current]')).toBeVisible();
    // The editor starts from the version in force.
    const box = page.getByLabel('The text');
    await expect(box).toHaveValue(/## Cookies and storage/);
    await expectNoHorizontalOverflow(page);
    await expectAllTargets(page);

    await box.fill('## Your data\n\nShorter words, with `a_name`.\n');
    const preview = page.locator('[data-preview]');
    await expect(
      preview.getByRole('heading', { name: 'Your data' }),
    ).toBeVisible();
    await expect(preview.locator('code')).toHaveText('a_name');

    await page.getByRole('button', { name: 'Publish as version 3' }).click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toContainText('Publish this text as version 3');
    await confirm
      .getByRole('button', { name: 'Yes, publish version 3' })
      .click();
    await expect(page.locator('[data-publish-status="done"]')).toHaveText(
      'Published version 3. It’s in force now.',
    );
    await expect(versions).toHaveCount(3);
    await expect(versions.nth(0)).toContainText('Version 3');
    await expect(versions.nth(0).locator('[data-current]')).toBeVisible();
    await expect(versions.nth(1).locator('[data-current]')).toHaveCount(0);

    // Each document has its own versions: the terms are untouched.
    await page.getByText('Terms of use', { exact: true }).click();
    await expect(
      page.getByRole('radio', { name: /^Terms of use/ }),
    ).toBeChecked();
    await expect(page.locator('[data-versions="terms"] > li')).toHaveCount(1);
    await expectNoHorizontalOverflow(page);
  });

  test('a stale publish (another admin published meanwhile) is refused and asks to reload', async ({
    browser,
  }) => {
    const session = `admin-${randomUUID().slice(0, 8)}`;
    const open = async () => {
      const page = await (await browser.newContext()).newPage();
      await useSession(page, session);
      await page.goto(`${WEB_SIGNED_IN_URL}/admin/legal`);
      await expect(page.getByLabel('The text')).toHaveValue(/Cookies/);
      return page;
    };
    const mine = await open();
    const theirs = await open();
    for (const [page, words] of [
      [theirs, 'Theirs.'],
      [mine, 'Mine.'],
    ] as const) {
      await page.getByLabel('The text').fill(words);
      await page.getByRole('button', { name: 'Publish as version 3' }).click();
      await page
        .getByRole('button', { name: 'Yes, publish version 3' })
        .click();
    }
    await expect(theirs.locator('[data-publish-status="done"]')).toBeVisible();
    const stale = mine.locator('[data-publish-status="stale"]');
    await expect(stale).toContainText('Someone else published a new version');
    await stale.getByRole('button', { name: 'Reload' }).click();
    await expect(mine.getByLabel('The text')).toHaveValue('Theirs.');
    await expect(
      mine.getByRole('button', { name: 'Publish as version 4' }),
    ).toBeVisible();
  });

  test('the first publication: an admin who hasn’t accepted sign-up (nothing to accept yet) stays on the page and publishes', async ({
    page,
    request,
  }) => {
    // A fresh environment: no version of either document, so the sign-up step can't be
    // completed until the first one is published here.
    const session = `admin-${randomUUID().slice(0, 8)}`;
    const seeded = await request.post(
      `${STUB_USER_URL}/__e2e/sessions/${session}`,
      { data: { signupAccepted: false, noLegalDocuments: true } },
    );
    expect(seeded.status()).toBe(204);
    await useSession(page, session);
    await page.goto(`${WEB_SIGNED_IN_URL}/admin/legal`);
    await expect(page.getByText('No version is published yet.')).toBeVisible();

    await page
      .getByLabel('The text')
      .fill('## Privacy policy\n\nThe first one.\n');
    await page.getByRole('button', { name: 'Publish as version 1' }).click();
    await page.getByRole('button', { name: 'Yes, publish version 1' }).click();
    await expect(page.locator('[data-publish-status="done"]')).toHaveText(
      'Published version 1. It’s in force now.',
    );
    // Still on the publishing page: never sent to the sign-up step.
    expect(new URL(page.url()).pathname).toBe('/admin/legal');
    await expect(page.locator('[data-versions="privacy"] > li')).toHaveCount(1);
  });

  test('only for admins: anyone else is told so and sees no versions', async ({
    page,
  }) => {
    await useSession(page, `user-${randomUUID().slice(0, 8)}`);
    await page.goto(`${WEB_SIGNED_IN_URL}/admin/legal`);
    await expect(page.locator('[data-admin-refused]')).toHaveText(
      'This page is for admins.',
    );
    await expect(page.locator('[data-versions]')).toHaveCount(0);
  });
});
