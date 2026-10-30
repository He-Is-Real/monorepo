import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import {
  expectAllTargets,
  expectNoHorizontalOverflow,
  expectTarget,
} from './helpers';
import { WEB_SIGNED_IN_URL } from './servers';

// The legal documents (D121, D123; Joel, 2026-10-30: "isn't privacy consent button and privacy
// policy and terms of use just the same document? but one needs an approve button"), on every
// device:
// - /privacy and /terms keep the site's own view of the words in force, with "Download this
//   version (PDF)" and, folded away, the previous versions with theirs (plain links: the browser
//   shows the PDF itself, no pop-up);
// - the sign-up step's terms box links the terms of use, outside the box's own words;
// - /admin/legal, for Admins: choose a document, upload a PDF and its words, preview the cleaned
//   copy, publish; the new version is in force and the old ones stay listed. The stub api-admin
//   (stub-api-user.mjs) keeps each test's versions apart by its session.

const LEGAL = resolve(__dirname, '../../../libs/legal');
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function useSession(page: Page, session: string) {
  await page.addInitScript(
    (s) => window.localStorage.setItem('e2e-session', s),
    session,
  );
}

test.describe('the privacy policy and terms of use pages', () => {
  test('/privacy: the words in force, this version’s PDF, and the previous versions with theirs', async ({
    page,
  }) => {
    await page.goto('/privacy');
    const policy = page.locator('[data-legal-version]');
    await expect(policy).toHaveAttribute(
      'data-legal-version',
      'dev_placeholder',
    );
    await expect(policy).toContainText(
      'Privacy document: development placeholder',
    );
    // The site's own cookies section stays below it.
    await expect(
      page.getByRole('heading', { name: 'Cookies and storage' }),
    ).toBeVisible();

    const download = page.getByRole('link', {
      name: 'Download this version (PDF)',
    });
    await expect(download).toHaveAttribute(
      'href',
      '/legal/privacy/dev_placeholder.pdf',
    );
    await expectTarget(page, download);

    const previous = page.locator('[data-previous-versions]');
    await expect(previous).toBeHidden();
    await page.getByText('Previous versions').click();
    await expect(previous.locator('li')).toHaveCount(1);
    await expect(
      previous.getByRole('link', { name: 'Download version 0 (PDF)' }),
    ).toHaveAttribute('href', '/legal/privacy/v0.pdf');

    await expectNoHorizontalOverflow(page);
    await expectAllTargets(page);
  });

  test('/terms: the words in force and their PDF', async ({ page }) => {
    await page.goto('/terms');
    await expect(page.locator('[data-legal-version]')).toContainText(
      'Terms of use: development placeholder',
    );
    await expect(
      page.getByRole('link', { name: 'Download this version (PDF)' }),
    ).toHaveAttribute('href', '/legal/terms/dev_placeholder.pdf');
    // Only one version so far: no "Previous versions".
    await expect(page.getByText('Previous versions')).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await expectAllTargets(page);
  });

  test('a PDF link gives exactly the PDF of record, inline and never sniffed; anything else is a 404', async ({
    request,
  }) => {
    for (const [document, file, name] of [
      ['privacy', 'dpa/dev_placeholder.pdf', 'privacy-policy'],
      ['terms', 'terms/dev_placeholder.pdf', 'terms-of-use'],
    ]) {
      const res = await request.get(`/legal/${document}/dev_placeholder.pdf`);
      expect([document, res.status()]).toEqual([document, 200]);
      expect(res.headers()['content-type']).toBe('application/pdf');
      expect(res.headers()['x-content-type-options']).toBe('nosniff');
      expect(res.headers()['content-disposition']).toBe(
        `inline; filename="heisreal-${name}-dev_placeholder.pdf"`,
      );
      expect(sha256(Buffer.from(await res.body()))).toBe(
        sha256(readFileSync(`${LEGAL}/${file}`)),
      );
    }
    for (const path of [
      'privacy/v9.pdf',
      'privacy/dev_placeholder',
      'other/v1.pdf',
      'privacy/..%2Fv1.pdf',
    ]) {
      const res = await request.get(`/legal/${path}`);
      expect([path, res.status()]).toEqual([path, 404]);
    }
  });
});

test('the sign-up step’s terms box links the terms of use, outside its words', async ({
  page,
}) => {
  await useSession(page, `unaccepted-${randomUUID().slice(0, 8)}`);
  await page.goto(`${WEB_SIGNED_IN_URL}/consent/sign-up`);
  const terms = page.getByRole('checkbox', {
    name: 'I agree to the terms of use.',
  });
  await expect(terms).not.toBeChecked();
  const link = page.getByRole('link', {
    name: 'Read the terms of use (opens in a new tab)',
  });
  await expect(link).toHaveAttribute('href', '/terms');
  await expect(link).toHaveAttribute('data-terms-version', 'dev_placeholder');
  await expectTarget(page, link);
  // The privacy policy, with its PDF, folded away.
  await page.getByText('Read the privacy policy', { exact: true }).click();
  await expect(
    page.locator('[data-privacy-document]').getByRole('link', {
      name: 'Download this version (PDF)',
    }),
  ).toHaveAttribute('href', '/legal/privacy/dev_placeholder.pdf');
  await expectNoHorizontalOverflow(page);
});

test.describe('/admin/legal', () => {
  test('an admin publishes a new privacy policy: the cleaned copy previewed, in force, the old one still listed', async ({
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
    await expect(versions).toHaveCount(1);
    await expect(versions.nth(0).locator('[data-current]')).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expectAllTargets(page);

    const file = readFileSync(`${LEGAL}/terms/dev_placeholder.pdf`);
    await page.getByLabel('The PDF (at most 10 MB)').setInputFiles({
      name: 'privacy-v2.pdf',
      mimeType: 'application/pdf',
      buffer: file,
    });
    await page
      .getByLabel('The words the site shows (Markdown)')
      .fill('# Privacy policy\n\nShorter words.\n');
    await page.getByRole('button', { name: 'Preview' }).click();
    const preview = page.locator('[data-preview]');
    await expect(preview.locator('object[type="application/pdf"]')).toHaveCount(
      1,
    );
    await expect(preview.locator('[data-preview-pdf-sha256]')).toHaveText(
      sha256(file),
    );
    await expect(preview.locator('[data-preview-text]')).toContainText(
      'Shorter words.',
    );

    await page.getByLabel('What changed').fill('Shorter words');
    await page.getByRole('button', { name: 'Publish this version' }).click();
    await expect(page.locator('[data-publish-status="done"]')).toHaveText(
      'Published version 2. It’s in force now.',
    );
    await expect(versions).toHaveCount(2);
    await expect(versions.nth(0)).toContainText('Version 2');
    await expect(versions.nth(0)).toContainText('Shorter words');
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
