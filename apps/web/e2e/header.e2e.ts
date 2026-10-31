import { expect, type Locator, type Page, test } from '@playwright/test';
import {
  enlargeText,
  expectAllTargets,
  expectNoHorizontalOverflow,
  expectTarget,
} from './helpers';
import { SCREENSHOT_DEVICES } from './devices';
import { SIGNED_IN_NAME, WEB_SIGNED_IN_URL } from './servers';

// The header with its account controls, signed out (Sign in, a link to the sign-in page, the
// same with or without Clerk) and signed in (a
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
      // Measured once the panel has finished opening: it zooms in from 95%, so mid-animation its
      // controls are briefly under 44 px.
      await panel.evaluate((el) =>
        Promise.all(el.getAnimations({ subtree: true }).map((x) => x.finished)),
      );
      await expectTarget(page, panel.getByRole('button', { name: 'Sign out' }));
      await expectTarget(
        page,
        panel.getByRole('link', { name: 'My favourites' }),
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
      await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
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
  ['signed out', undefined, { role: 'link', name: 'Sign in' }],
  [
    'signed in',
    WEB_SIGNED_IN_URL,
    { role: 'button', name: `Account: ${SIGNED_IN_NAME}` },
  ],
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
    await expect(
      page.getByRole(resolved.role, { name: resolved.name }),
    ).toBeVisible();
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

// With text at 200% on every device, signed out and signed in, every header control is on
// screen and none covers another, and the page neither scrolls sideways nor zooms out: the
// account slot's width must never push Share, the theme toggle or the menu off the screen
// (Codex review of #83; the tablets and landscape phones overflowed until the fix).
for (const [state, baseURL, resolved] of [
  ['signed out', undefined, { role: 'link', name: 'Sign in' }],
  [
    'signed in',
    WEB_SIGNED_IN_URL,
    { role: 'button', name: `Account: ${SIGNED_IN_NAME}` },
  ],
] as const) {
  test(`200% text, ${state}: every header control is on screen`, async ({
    page,
  }) => {
    await enlargeText(page);
    await page.goto(`${baseURL ?? ''}/`);
    await expect(
      page.getByRole(resolved.role, { name: resolved.name }),
    ).toBeVisible();
    const header = page.getByRole('banner');
    const width = page.viewportSize()?.width ?? 0;
    // Share is in the header from 640 px; below that it's in the menu.
    const controls = {
      home: header.getByRole('link', { name: 'He Is Real Today, home' }),
      theme: header.getByRole('button', { name: /theme/i }),
      account: header.getByRole(resolved.role, { name: resolved.name }),
      ...(width < 640
        ? { menu: header.getByRole('button', { name: 'Menu' }) }
        : {
            share: header
              .locator('[data-header-actions]')
              .getByRole('link', { name: 'Share your story' }),
          }),
    };
    type Box = { x: number; y: number; width: number; height: number };
    const boxes: [string, Box][] = [];
    for (const [name, control] of Object.entries(controls)) {
      await expect(control, `${name} is shown`).toBeVisible();
      await expectTarget(page, control);
      const box = await control.boundingBox();
      if (!box) throw new Error(`${name} not rendered`);
      expect(box.x, `${name} starts off screen`).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, `${name} ends off screen`).toBeLessThanOrEqual(
        width,
      );
      boxes.push([name, box]);
    }
    // None covers another (they may wrap onto more rows).
    const overlap = (a: Box, b: Box) =>
      Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 0.5 &&
      Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 0.5;
    for (const [i, [a, boxA]] of boxes.entries())
      for (const [b, boxB] of boxes.slice(i + 1))
        expect(overlap(boxA, boxB), `${a} covers ${b}`).toBe(false);
    await expectNoHorizontalOverflow(page);
  });
}

// A visitor who opens the phone menu while the page's JavaScript is still loading keeps it:
// when React takes over, the menu is still open and focus is still on the link they were on
// (Codex review of #83).
test('the phone menu stays open, focus where it was, when JavaScript arrives', async ({
  page,
}, info) => {
  test.skip(
    !['phone-320', 'iphone-se'].includes(info.project.name),
    '320 and 375 px',
  );
  // The page's scripts wait until released.
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => (release = resolve));
  let held = 0;
  await page.route('**/_next/static/**/*.js', async (route) => {
    held++;
    await released;
    await route.continue();
  });
  await page.goto('/about', { waitUntil: 'commit' });
  const summary = page.locator('[data-mobile-nav] summary', {
    hasText: 'Menu',
  });
  await summary.click();
  const nav = page.getByRole('navigation', { name: 'Menu' });
  const stories = nav.getByRole('link', { name: 'Stories', exact: true });
  await stories.focus();
  await expect(stories).toBeFocused();
  expect(held, 'no JavaScript was held back').toBeGreaterThan(0);

  release();
  // React has taken over: the menu button replaces the disclosure.
  const button = page.getByRole('button', { name: 'Menu' });
  await expect(button).toBeVisible();
  await expect(page.locator('[data-mobile-nav] summary')).toHaveCount(0);
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  await expect(nav).toBeVisible();
  await expect(stories).toBeFocused();
  // And it behaves as the button's menu: Escape closes it and focus returns to the button.
  await page.keyboard.press('Escape');
  await expect(nav).toBeHidden();
  await expect(button).toBeFocused();
});
