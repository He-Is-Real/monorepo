import { randomUUID } from 'node:crypto';
import {
  type APIRequestContext,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { BEHAVIOUR_DEVICES } from './devices';
import { expectAllTargets, expectNoHorizontalOverflow } from './helpers';
import { fixtureToken, STUB_USER_URL, WEB_SIGNED_IN_URL } from './servers';

// Plan 4e: agreeing to the terms of use and the testimony consent, and the admins' page that
// saves new versions of the four legal texts, on the signed-in server against the stub api-user
// (stub-api-user.mjs, checked against the contracts in contract.e2e.ts). The texts and their
// versions are legal-fixtures.mjs: terms of use 0–2, testimony consent 0–3, social media sharing
// 0–1, privacy notice 0–1. What the database records and refuses is api-user's integration tests.

/** A new person for this test: their session in the stub, and in the page's storage. */
async function person(
  page: Page,
  request: APIRequestContext,
  seed: Record<string, unknown>,
  prefix = '',
) {
  const id = `${prefix}${randomUUID().replace(/-/g, '')}`;
  const res = await request.post(`${STUB_USER_URL}/__e2e/sessions/${id}`, {
    data: seed,
  });
  expect(res.status()).toBe(204);
  await page.addInitScript((session) => {
    window.localStorage.setItem('e2e-session', session);
  }, id);
  return {
    id,
    /** The agreements the page sent, oldest first. */
    agreed: async () =>
      (
        await (
          await request.get(`${STUB_USER_URL}/__e2e/sessions/${id}/agreed`)
        ).json()
      ).requests as { document: string; version: number }[],
  };
}

const tick = (page: Page, label: string | RegExp) =>
  page.locator('label').filter({ hasText: label }).click();
const CONTINUE = { name: 'Continue', exact: true } as const;

test.describe('behaviour', () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, info) => {
    test.skip(
      !BEHAVIOUR_DEVICES.includes(info.project.name),
      'one phone and one desktop',
    );
  });

  test('sign-up: one box for the terms, with the privacy notice, and nothing saved until it’s ticked', async ({
    page,
    request,
  }) => {
    const me = await person(page, request, { terms: null }, 'unaccepted');
    await page.goto(`${WEB_SIGNED_IN_URL}/about`);
    // A new account goes to the terms first, and comes back after.
    await expect(page).toHaveURL(/\/consent\/terms\?redirect_url=%2Fabout$/);
    await expect(
      page.getByRole('heading', {
        level: 1,
        name: 'Welcome to He Is Real Today',
      }),
    ).toBeVisible();
    const form = page.locator('[data-agreement="terms-of-use"]');
    await expect(form).toHaveAttribute('data-agreement-version', '2');
    await expect(form.getByRole('checkbox')).toHaveCount(1);
    await expect(form.getByRole('checkbox')).not.toBeChecked();
    await expect(form.locator('[data-legal-document]')).toContainText(
      'in your own words',
    );
    await expect(
      form.locator('[data-privacy-notice-link]').getByRole('link', {
        name: 'privacy notice',
      }),
    ).toHaveAttribute('href', '/privacy');
    await page.getByRole('button', CONTINUE).click();
    await expect(form).toContainText(
      'Tick the box to continue. Nothing is saved until you do.',
    );
    expect(await me.agreed()).toEqual([]);
    await tick(page, 'I am 18 or over and agree to the terms of use.');
    await page.getByRole('button', CONTINUE).click();
    await expect(page).toHaveURL(`${WEB_SIGNED_IN_URL}/about`);
    expect(await me.agreed()).toEqual([
      { document: 'terms-of-use', version: 2 },
    ]);
  });

  test('changed terms: the redline from the version agreed, the full text, and agreeing again', async ({
    page,
    request,
  }) => {
    const me = await person(page, request, {
      terms: 0,
      staleOnce: ['terms-of-use'],
    });
    await page.goto(`${WEB_SIGNED_IN_URL}/stories`);
    await expect(page).toHaveURL(/\/consent\/terms\?redirect_url=%2Fstories$/);
    await expect(
      page.getByRole('heading', {
        level: 1,
        name: 'Our terms of use have changed',
      }),
    ).toBeVisible();
    const form = page.locator('[data-agreement="terms-of-use"]');
    await expect(form).toContainText(
      'You agreed to version 0 on 26 Oct 2026. Here’s what’s different in version 2.',
    );
    // Both later versions' words, against version 0, marked for screen readers too.
    await expect(form.locator('[data-redline] ins')).toHaveText([
      /\[added: .*and tell us if someone else uses your account.*\]/,
      /\[added: .*and in your own words.*\]/,
    ]);
    await form.getByText('Read the full version 2').click();
    await expect(form.locator('[data-full-version="2"]')).toContainText(
      'in your own words',
    );
    await expect(form.locator('[data-privacy-notice-link]')).toBeVisible();

    // A newer version is saved while the page is open: nothing is agreed, and it says so.
    await tick(page, 'I agree to version 2 of the terms of use.');
    await page.getByRole('button', CONTINUE).click();
    await expect(form.locator('[data-agreement-problem]')).toContainText(
      'We updated the terms of use while you were reading.',
    );
    await expect(form.getByRole('checkbox')).not.toBeChecked();
    await tick(page, 'I agree to version 2 of the terms of use.');
    await page.getByRole('button', CONTINUE).click();
    await expect(page).toHaveURL(`${WEB_SIGNED_IN_URL}/stories`);
    expect(await me.agreed()).toEqual([
      { document: 'terms-of-use', version: 2 },
      { document: 'terms-of-use', version: 2 },
    ]);
  });

  test('changed testimony consent: a banner, the redline, and stories stay up if not now', async ({
    page,
    request,
  }) => {
    const me = await person(page, request, { testimony: 1 });
    await page.goto(`${WEB_SIGNED_IN_URL}/about`);
    const banner = page.locator('[data-consent-banner]');
    await expect(banner).toContainText('Our testimony consent has changed');
    // "Not now" hides it for now.
    await banner.getByRole('button', { name: 'Not now' }).click();
    await expect(banner).toHaveCount(0);
    await page.reload();
    await banner.getByRole('link', { name: 'Read what’s changed' }).click();
    await expect(page).toHaveURL(
      /\/consent\/testimony\?redirect_url=%2Fabout$/,
    );
    await expect(
      page.getByRole('heading', {
        level: 1,
        name: 'Our testimony consent has changed',
      }),
    ).toBeVisible();
    const form = page.locator('[data-agreement="testimony-consent"]');
    await expect(form).toContainText('Here’s what’s different in version 3.');
    await expect(form.locator('[data-redline] ins')).toHaveCount(2);
    await expect(form.locator('[data-redline]')).toContainText(
      '[added: , from your profile]',
    );
    await expect(page.getByRole('region', { name: 'Not now' })).toContainText(
      'Your published stories stay up.',
    );
    await tick(page, 'I agree to version 3 of the testimony consent.');
    await page.getByRole('button', CONTINUE).click();
    await expect(page).toHaveURL(`${WEB_SIGNED_IN_URL}/about`);
    await expect(banner).toHaveCount(0);
    expect(await me.agreed()).toEqual([
      { document: 'testimony-consent', version: 3 },
    ]);
  });

  test('someone who never agreed to the testimony consent sees no banner', async ({
    page,
    request,
  }) => {
    await person(page, request, {});
    await page.goto(`${WEB_SIGNED_IN_URL}/about`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.locator('[data-consent-banner]')).toHaveCount(0);
  });

  test('the privacy notice and terms keep every version from 0', async ({
    page,
  }) => {
    await page.goto('/privacy');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Privacy notice',
    );
    await expect(page.locator('[data-legal-version]')).toHaveAttribute(
      'data-legal-version',
      '1',
    );
    const others = page.locator('[data-document-versions]');
    await expect(
      others.getByRole('heading', { name: 'Previous versions' }),
    ).toBeVisible();
    await others.getByRole('link', { name: /^Version 0,/ }).click();
    await expect(page).toHaveURL(/\/privacy\/versions\/0$/);
    await expect(page.getByRole('note')).toContainText(
      'This is an earlier version',
    );
    await expect(page.getByRole('main')).not.toContainText('Donations');
    await expect(
      others.getByRole('link', { name: /^Version 1 \(latest\)/ }),
    ).toHaveAttribute('href', '/privacy');
    expect((await page.goto('/terms/versions/0'))?.status()).toBe(200);
    await expect(page.locator('[data-legal-version]')).toHaveAttribute(
      'data-legal-version',
      '0',
    );
    expect((await page.goto('/terms/versions/9'))?.status()).toBe(404);
  });

  test('/admin/consent: edit, see the redline and preview, confirm, and save the next version', async ({
    page,
    request,
  }) => {
    await person(page, request, {}, 'admin');
    await page.goto(`${WEB_SIGNED_IN_URL}/admin/consent`);
    await page.getByRole('tab', { name: 'Privacy notice' }).click();
    await expect(page.locator('[data-current-version]')).toContainText(
      'Current: version 1',
    );
    await page.getByText('See all versions').click();
    await expect(page.locator('[data-versions] [data-version]')).toHaveCount(2);
    const text = page.getByLabel('New text (version 2) · Markdown');
    await text.fill(`${await text.inputValue()}\n\nOne more paragraph.`);
    await expect(page.locator('[data-redline] ins')).toHaveText(
      '[added: One more paragraph.]',
    );
    await expect(page.locator('[data-preview]')).toContainText(
      'One more paragraph.',
    );
    await page.getByRole('button', { name: 'Save as version 2…' }).click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toContainText(
      'Save version 2 of privacy notice? It can’t be changed or deleted after saving.',
    );
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toHaveCount(0);
    await page.getByRole('button', { name: 'Save as version 2…' }).click();
    await confirm.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('[data-publish-status="done"]')).toHaveText(
      'Saved version 2. It’s in force now.',
    );
    await expect(page.locator('[data-current-version]')).toContainText(
      'Current: version 2',
    );
  });

  test('/admin/consent: another admin saved first, so nothing is saved and it asks to reload', async ({
    page,
    request,
  }) => {
    const me = await person(page, request, {}, 'admin');
    await page.goto(`${WEB_SIGNED_IN_URL}/admin/consent`);
    await expect(page.locator('[data-current-version]')).toContainText(
      'Current: version 2',
    );
    // The terms of use's version 3, saved by someone else after this page loaded.
    const theirs = await request.post(
      `${STUB_USER_URL}/v1/admin/legal-documents/terms-of-use/versions`,
      {
        headers: {
          authorization: `Bearer ${fixtureToken(me.id)}`,
        },
        data: { version: 3, content: 'Their text.' },
      },
    );
    expect(theirs.status()).toBe(201);
    const text = page.getByLabel('New text (version 3) · Markdown');
    await text.fill(`${await text.inputValue()}\n\nMine.`);
    await page.getByRole('button', { name: 'Save as version 3…' }).click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Save' })
      .click();
    const stale = page.locator('[data-publish-status="stale"]');
    await expect(stale).toContainText(
      'Someone else saved version 3 of the terms of use while you were editing',
    );
    await stale.getByRole('button', { name: 'Reload' }).click();
    await expect(page.locator('[data-current-version]')).toContainText(
      'Current: version 3',
    );
    await expect(
      page.getByLabel('New text (version 4) · Markdown'),
    ).toHaveValue('Their text.');
  });
});

// Every device: the new pages fit, with 44 px targets (200% text: text-zoom.e2e.ts).
test.describe('layout', () => {
  for (const [name, seed, path, prefix] of [
    ['first terms', { terms: null }, '/consent/terms', 'unaccepted'],
    ['changed terms', { terms: 0 }, '/consent/terms', ''],
    ['testimony consent', { testimony: 1 }, '/consent/testimony', ''],
    ['admin consent', {}, '/admin/consent', 'admin'],
  ] as const) {
    test(`${name}: fits, with its targets`, async ({ page, request }) => {
      await person(page, request, seed, prefix);
      await page.goto(`${WEB_SIGNED_IN_URL}${path}`);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      if (path === '/admin/consent') {
        await expect(page.locator('[data-preview]')).toBeVisible();
      } else {
        await expect(page.locator('[data-agreement]')).toBeVisible();
      }
      await expectNoHorizontalOverflow(page);
      await expectAllTargets(page);
    });
  }
});
