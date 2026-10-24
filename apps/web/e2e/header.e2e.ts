import { expect, type Page, test } from '@playwright/test';
import {
  expectAllTargets,
  expectNoHorizontalOverflow,
  expectTarget,
} from './helpers';
import { SIGNED_IN_NAME, WEB_SIGNED_IN_URL } from './servers';

// The header with its account controls, signed out (Clerk's Sign in button) and signed in (a
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
      // Before the checks, so a failing layout is on record too.
      await page.screenshot({
        path: `test-output/e2e/screenshots/${info.project.name}/${scheme}-header-signed-in.png`,
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
