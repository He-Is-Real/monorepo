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
    await expect(
      page.getByRole('tab', { name: 'Privacy notice' }),
    ).toContainText('v2 · ');
  });

  // CS-1 C4 (Joel, 2026-11-17): underlined tabs with each text's current version and date, and
  // the chosen text in the address.
  test('/admin/consent: tabs give each text’s version and date, and the address keeps the text', async ({
    page,
    request,
  }) => {
    await person(page, request, {}, 'admin');
    await page.goto(`${WEB_SIGNED_IN_URL}/admin/consent`);
    const tab = (name: string) => page.getByRole('tab', { name });
    // The fixtures' dates are in October 2026; the year shows only outside the current one.
    const when = (day: number) =>
      new Date().getFullYear() === 2026 ? `${day} Oct` : `${day} Oct 2026`;
    await expect(tab('Terms of use')).toContainText(`v2 · ${when(20)}`);
    await expect(tab('Testimony consent')).toContainText(`v3 · ${when(22)}`);
    await expect(tab('Social media sharing')).toContainText(`v1 · ${when(15)}`);
    await expect(tab('Privacy notice')).toContainText(`v1 · ${when(25)}`);
    await expect(tab('Terms of use')).toHaveAttribute('aria-selected', 'true');

    await tab('Privacy notice').click();
    await expect(page).toHaveURL(/\/admin\/consent\?text=privacy-notice$/);
    await expect(tab('Privacy notice')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(
      page.getByRole('heading', { level: 2, name: 'Privacy notice' }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole('heading', { level: 2, name: 'Privacy notice' }),
    ).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/\/admin\/consent$/);
    await expect(
      page.getByRole('heading', { level: 2, name: 'Terms of use' }),
    ).toBeVisible();
    await expect(tab('Terms of use')).toHaveAttribute('aria-selected', 'true');

    // Arrow keys move between the tabs; an unknown text is the terms of use.
    await tab('Terms of use').focus();
    await page.keyboard.press('ArrowRight');
    await expect(tab('Testimony consent')).toBeFocused();
    await expect(page).toHaveURL(/\?text=testimony-consent$/);
    await page.goto(`${WEB_SIGNED_IN_URL}/admin/consent?text=nonsense`);
    await expect(tab('Terms of use')).toHaveAttribute('aria-selected', 'true');

    // Phones: two rows of two; from 768 px one row.
    const boxes = await Promise.all(
      [
        'Terms of use',
        'Testimony consent',
        'Social media sharing',
        'Privacy notice',
      ].map(async (name) => {
        const box = await tab(name).boundingBox();
        if (!box) throw new Error('not rendered');
        return box;
      }),
    );
    const rows = new Set(boxes.map((b) => Math.round(b.y))).size;
    expect(rows).toBe((page.viewportSize()?.width ?? 0) < 768 ? 2 : 1);
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

  // Joel, 2026-11-14: on desktop (1280 px and up) the edit box and the preview take twice the
  // standard content width (800 px) between them, each still within it; phones and tablets keep
  // the standard column.
  test('admin consent: the edit box and preview take double width on desktop only', async ({
    page,
    request,
  }) => {
    await person(page, request, {}, 'admin');
    await page.goto(`${WEB_SIGNED_IN_URL}/admin/consent`);
    const panes = page.locator('[data-editor-panes]');
    await expect(panes).toBeVisible();
    const width = page.viewportSize()?.width ?? 0;
    const panesBox = await panes.boundingBox();
    const edit = await panes.locator('> div').first().boundingBox();
    const preview = await page.locator('[data-preview]').boundingBox();
    if (!panesBox || !edit || !preview) throw new Error('not rendered');
    if (width >= 1280) {
      // Up to twice 800 px, less the page's padding; the screen's width where it's narrower.
      expect(panesBox.width).toBeGreaterThan(1100);
      expect(panesBox.width).toBeLessThanOrEqual(1520);
      expect(edit.width).toBeLessThanOrEqual(800);
      expect(preview.width).toBeLessThanOrEqual(800);
      expect(preview.x).toBeGreaterThan(edit.x + edit.width); // side by side
    } else {
      expect(panesBox.width).toBeLessThanOrEqual(800);
    }
  });

  // Joel, 2026-11-17: from 768 px (tablets and desktops) the edit box is as tall as its whole
  // text, so it never scrolls inside (the page does); phones keep 20 rows and scroll inside.
  test('admin consent: the edit box grows to its whole text on tablets and desktops only', async ({
    page,
    request,
  }) => {
    await person(page, request, {}, 'admin');
    await page.goto(`${WEB_SIGNED_IN_URL}/admin/consent`);
    const text = page.getByLabel('New text (version 3) · Markdown');
    await expect(text).toBeVisible();
    const size = () =>
      text.evaluate((el) => ({
        scroll: el.scrollHeight,
        client: el.clientHeight,
      }));
    const lines = (n: number, word: string) =>
      Array.from({ length: n }, (_, i) => `${word} ${i + 1}.`).join('\n\n');
    const fixed = await size();
    await text.fill(lines(60, 'A long paragraph'));
    const long = await size();
    await text.press('End');
    await text.pressSequentially('\n\nMore.\n\nAnd more.\n\nAnd more again.');
    const longer = await size();
    if ((page.viewportSize()?.width ?? 0) >= 768) {
      expect(long.scroll).toBeLessThanOrEqual(long.client);
      expect(long.client).toBeGreaterThan(fixed.client);
      expect(longer.scroll).toBeLessThanOrEqual(longer.client);
      expect(longer.client).toBeGreaterThan(long.client);
    } else {
      expect(long.client).toBe(fixed.client);
      expect(longer.client).toBe(fixed.client);
      expect(long.scroll).toBeGreaterThan(long.client); // scrolls inside
    }
    await expectNoHorizontalOverflow(page);
  });

  // Typing near the end of a box taller than the preview must not move the page: no jump while
  // the box is measured, and no smooth scroll back (Codex review of the full-height box).
  test('admin consent: typing at the end of a long text keeps the page still on tablets and desktops', async ({
    page,
    request,
  }) => {
    test.skip(
      (page.viewportSize()?.width ?? 0) < 768,
      'the box only grows from 768 px',
    );
    await person(page, request, {}, 'admin');
    await page.goto(`${WEB_SIGNED_IN_URL}/admin/consent`);
    const text = page.getByLabel('New text (version 3) · Markdown');
    await expect(text).toBeVisible();
    await text.fill(`Top\n${'\n'.repeat(200)}Bottom`);
    // The preview and redline follow the text a moment later; wait for them to settle.
    await expect(page.locator('[data-preview]')).toHaveText(
      /^\s*Top\s*Bottom\s*$/,
    );
    await text.evaluate((el: HTMLTextAreaElement) => {
      el.setSelectionRange(el.value.length, el.value.length);
      const box = el.getBoundingClientRect();
      window.scrollTo({
        top: window.scrollY + box.bottom - window.innerHeight / 2,
        behavior: 'instant',
      });
    });
    // Scrolling (and putting the caret at the end) can take a frame to land: wait until the
    // page holds still for a few frames.
    const before = await page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          let last = window.scrollY;
          let still = 0;
          const next = () => {
            still = window.scrollY === last ? still + 1 : 0;
            last = window.scrollY;
            if (still >= 3) resolve(last);
            else requestAnimationFrame(next);
          };
          requestAnimationFrame(next);
        }),
    );
    expect(before).toBeGreaterThan(0);
    await page.keyboard.type('x');
    // scrollY on each of the next frames, long enough to see any smooth scroll.
    const frames = await page.evaluate(
      () =>
        new Promise<number[]>((resolve) => {
          const seen: number[] = [window.scrollY];
          const next = () => {
            seen.push(window.scrollY);
            if (seen.length >= 20) resolve(seen);
            else requestAnimationFrame(next);
          };
          requestAnimationFrame(next);
        }),
    );
    await expect(text).toHaveValue(/Bottomx$/);
    for (const y of frames) expect(Math.abs(y - before)).toBeLessThanOrEqual(1);
  });
});
