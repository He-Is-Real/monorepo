import { expect, type Locator, type Page, test } from '@playwright/test';
import {
  expectAllTargets,
  expectNoHorizontalOverflow,
  expectTarget,
} from './helpers';
import { SCREENSHOT_DEVICES } from './devices';
import { SIGNED_IN_NAME, WEB_SIGNED_IN_URL } from './servers';

// The header with its account controls, signed out (the E2E_FIXTURES stand-in for Clerk's Sign
// in button, the same Button; the real one is in static-pages.e2e.ts) and signed in (a
// 40-character name from the E2E_FIXTURES server: no Clerk session needed). On every device and
// in both schemes the action group stays on the first row, beside the logo, right-aligned:
// never wrapped under the navigation or pushed left, nothing wider than the screen, every
// target at least 44 px.

async function expectActionsOnFirstRow(page: Page) {
  const logo = page.getByRole('link', { name: 'He Is Real Today, home' });
  const actions = page.locator('[data-header-actions]');
  await expect(actions).toBeVisible();
  const [l, a] = [await logo.boundingBox(), await actions.boundingBox()];
  if (!l || !a) throw new Error('header parts not rendered');
  // Same row: the action group overlaps the logo's row vertically.
  expect(a.y, 'actions start below the logo row').toBeLessThan(l.y + l.height);
  expect(a.y + a.height, 'actions end above the logo row').toBeGreaterThan(l.y);
  // Right-aligned: the group ends at the header's right content edge.
  const contentRight = await page
    .locator('header > div')
    .first()
    .evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.right - parseFloat(getComputedStyle(el).paddingRight);
    });
  expect(
    Math.abs(contentRight - (a.x + a.width)),
    'actions are not right-aligned',
  ).toBeLessThanOrEqual(1);
  const width = page.viewportSize()?.width ?? 0;
  expect(a.x).toBeGreaterThanOrEqual(0);
  expect(a.x + a.width).toBeLessThanOrEqual(width);
  // Where the navigation shares the first row (wide screens), it ends before the actions.
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  if (await nav.isVisible()) {
    const n = await nav.boundingBox();
    if (n && n.y < l.y + l.height) {
      expect(
        n.x + n.width,
        'navigation runs into the actions',
      ).toBeLessThanOrEqual(a.x);
    }
  }
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} scheme`, () => {
    test.use({ colorScheme: scheme });

    test('signed in with a long name: the actions stay on the first row, right-aligned', async ({
      page,
    }, info) => {
      await page.goto(`${WEB_SIGNED_IN_URL}/`);
      // The design's compact control: avatar initial and first name; the full name is its
      // accessible name and in the panel it opens.
      const account = page.getByRole('button', {
        name: `Account: ${SIGNED_IN_NAME}`,
      });
      await expect(account).toBeVisible();
      // Before the checks, so a failing layout is on record too (on the 4 screenshot sizes).
      if (SCREENSHOT_DEVICES.includes(info.project.name))
        await page.screenshot({
          path: `test-output/e2e/screenshots/${info.project.name}/${scheme}-header-signed-in.jpg`,
          type: 'jpeg',
          scale: 'css',
          quality: 50,
        });
      await expectActionsOnFirstRow(page);
      await expectNoHorizontalOverflow(page);
      await expectAllTargets(page);

      await account.click();
      const panel = page.getByRole('dialog');
      await expect(panel).toContainText(`Signed in as ${SIGNED_IN_NAME}`);
      const signOut = panel.getByRole('button', { name: 'Sign out' });
      await expectTarget(page, signOut);
      await panel.evaluate((el) =>
        Promise.all(el.getAnimations({ subtree: true }).map((x) => x.finished)),
      );
      const box = await panel.boundingBox();
      const { width, height } = page.viewportSize() ?? { width: 0, height: 0 };
      expect(
        (box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= width,
      ).toBe(true);
      expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(
        height + 0.5,
      );
      await page.keyboard.press('Escape');
      await expect(panel).toHaveCount(0);
      await expect(account).toBeFocused();
    });

    test('signed out: the actions stay on the first row, right-aligned', async ({
      page,
    }) => {
      await page.goto('/');
      await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
      await expectActionsOnFirstRow(page);
      await expectNoHorizontalOverflow(page);
    });
  });
}

// Nothing in the header moves when the account control arrives: the first paint shows a
// placeholder in its place (and that's all a visitor without JavaScript ever gets), then it
// resolves to "Sign in" or the signed-in control. Share and the theme toggle keep their places
// on every device, signed out and signed in with a long name.
for (const [state, baseURL, resolved] of [
  ['signed out', undefined, 'Sign in'],
  ['signed in', WEB_SIGNED_IN_URL, `Account: ${SIGNED_IN_NAME}`],
] as const) {
  test(`${state}: Share and the theme toggle don't move when the account control resolves`, async ({
    browser,
    page,
  }, info) => {
    const url = `${baseURL ?? ''}/`;
    const positions = async (p: Page) => {
      await p.evaluate(() => document.fonts.ready);
      const actions = p.locator('[data-header-actions]');
      const x = async (l: Locator) =>
        (await l.isVisible()) ? ((await l.boundingBox())?.x ?? null) : null;
      return {
        share: await x(actions.getByRole('link', { name: 'Share your story' })),
        theme: await x(actions.getByRole('button', { name: /theme/i })),
      };
    };
    const {
      viewport,
      isMobile,
      hasTouch,
      deviceScaleFactor,
      baseURL: base,
    } = info.project.use;
    const firstPaint = await browser.newContext({
      viewport,
      isMobile,
      hasTouch,
      deviceScaleFactor,
      baseURL: base,
      javaScriptEnabled: false,
    });
    const before = await firstPaint.newPage();
    await before.goto(url);
    const placeholder = await positions(before);
    await firstPaint.close();

    await page.goto(url);
    await expect(page.getByRole('button', { name: resolved })).toBeVisible();
    const after = await positions(page);
    expect(after.theme, 'the theme toggle is shown').not.toBeNull();
    for (const part of ['share', 'theme'] as const) {
      if (after[part] === null) continue; // Share is in the menu below 640 px
      expect(
        Math.abs((after[part] ?? 0) - (placeholder[part] ?? -999)),
        `${part} moved`,
      ).toBeLessThanOrEqual(0.5);
    }
  });
}

// The phone menu without JavaScript (a disclosure the browser opens itself): Menu opens it and
// its links work. 320 and 375 px.
test.describe('phone menu without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('Menu opens the links, and Stories is reachable', async ({
    page,
  }, info) => {
    test.skip(
      !['phone-320', 'iphone-se'].includes(info.project.name),
      '320 and 375 px',
    );
    await page.goto('/about');
    const nav = page.getByRole('navigation', { name: 'Menu' });
    await expect(nav).toBeHidden();
    await page
      .locator('[data-mobile-nav] summary', { hasText: 'Menu' })
      .click();
    await expect(nav).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await nav.getByRole('link', { name: 'Stories', exact: true }).click();
    await expect(page).toHaveURL(/\/stories$/);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });
});
