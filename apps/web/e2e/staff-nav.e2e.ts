import { expect, type Locator, type Page, test } from '@playwright/test';
import { BEHAVIOUR_DEVICES, SCREENSHOT_DEVICES } from './devices';
import { expectAllTargets, expectNoHorizontalOverflow } from './helpers';
import { WEB_SIGNED_IN_URL } from './servers';

// Staff links in the site's main navigation (Joel, 2026-11-14): after the public links, set apart
// by a thin line, Moderation for Moderators and Admins and Consent & legal (the legal text editor)
// for Admins only. Nobody else sees them: not signed-out people, not Users, and nobody until their
// role is known. The navigation with both links fits every device (the desktop's one row, the
// tablet's second row, the phone's menu); the behaviour runs on one phone and one desktop. The
// stub api-user (stub-api-user.mjs) makes sessions starting `admin` Admins and `moderator`
// Moderators; everyone else is a User.

async function useSession(page: Page, session: string) {
  await page.addInitScript(
    (s) => window.localStorage.setItem('e2e-session', s),
    session,
  );
}

/** Phones (below 640 px) have the menu; wider screens the header's links. */
const isPhone = (page: Page) => (page.viewportSize()?.width ?? 0) < 640;

/** The navigation that shows on this device: the menu (opened) on phones, else the header's. */
async function openNav(page: Page): Promise<Locator> {
  if (isPhone(page)) {
    // The button replaces the no-JavaScript disclosure once React runs; click waits for it.
    await page.getByRole('button', { name: 'Menu' }).click();
    return page.getByRole('navigation', { name: 'Menu' });
  }
  return page.getByRole('navigation', { name: 'Main navigation' });
}

/** Signed in as `session`, on the home page, once api-user has said who they are. */
async function signedInHome(page: Page, session: string) {
  await useSession(page, session);
  const account = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/v1/account' && r.ok(),
  );
  await page.goto(`${WEB_SIGNED_IN_URL}/`);
  await account;
  await expect(page.getByRole('button', { name: /^Account: / })).toBeVisible();
}

test('the navigation with both staff links fits, with 44 px targets', async ({
  page,
}, info) => {
  await useSession(page, 'admin-nav-fit');
  await page.goto(`${WEB_SIGNED_IN_URL}/`);
  const nav = await openNav(page);
  await expect(
    nav.getByRole('link', { name: 'Consent & legal' }),
  ).toBeVisible();
  if (SCREENSHOT_DEVICES.includes(info.project.name))
    await page.screenshot({
      path: `test-output/e2e/screenshots/${info.project.name}/light-staff-nav.jpg`,
      type: 'jpeg',
      scale: 'css',
      quality: 50,
    });
  await expectNoHorizontalOverflow(page);
  await expectAllTargets(page);
  if (!isPhone(page)) {
    // No link's words break onto a second line, the public links keep their one row, and the
    // two staff links stay together (on that row, or as a group under it where it's full).
    const tops = async (l: Locator) =>
      l.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().top));
    const heights = await nav
      .getByRole('link')
      .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
    for (const h of heights)
      expect(h, 'a link wraps onto two lines').toBeLessThanOrEqual(44.5);
    for (const group of [
      nav.locator('li:not([data-staff-links]) > a'),
      nav.locator('[data-staff-link]'),
    ]) {
      const t = await tops(group);
      for (const top of t)
        expect(Math.abs(top - t[0]), 'a group splits').toBeLessThanOrEqual(1);
    }
    // On wide screens the links share the logo's line; they end before the actions.
    const n = await nav.boundingBox();
    const a = await page.locator('[data-header-actions]').boundingBox();
    if (n && a && n.y < a.y + a.height && a.y < n.y + n.height)
      expect(
        n.x + n.width,
        'navigation runs into the actions',
      ).toBeLessThanOrEqual(a.x);
  }
});

test.describe('staff links', () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, info) => {
    test.skip(
      !BEHAVIOUR_DEVICES.includes(info.project.name),
      'one phone and one desktop',
    );
  });

  test('an admin sees Moderation and Consent & legal after the public links, and both open', async ({
    page,
  }) => {
    await signedInHome(page, 'admin-nav');
    let nav = await openNav(page);
    await expect(nav.getByRole('link')).toHaveText([
      'Stories',
      'About',
      'FAQs',
      'Greatest Story',
      'Contact',
      'Donate',
      'Moderation',
      'Consent & legal',
    ]);
    await nav.getByRole('link', { name: 'Moderation' }).click();
    await expect(page).toHaveURL(/\/moderation$/);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Moderation' }),
    ).toBeVisible();

    nav = await openNav(page);
    await expect(nav.getByRole('link', { name: 'Moderation' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await nav.getByRole('link', { name: 'Consent & legal' }).click();
    await expect(page).toHaveURL(/\/admin\/consent$/);
    await expect(page.locator('[data-admin-refused]')).toHaveCount(0);
    await expect(
      page.getByRole('navigation', { name: 'Admin pages' }),
    ).toBeVisible();
  });

  test('a moderator sees Moderation only', async ({ page }) => {
    await signedInHome(page, 'moderator-nav');
    const nav = await openNav(page);
    await expect(nav.getByRole('link', { name: 'Moderation' })).toBeVisible();
    await expect(
      nav.getByRole('link', { name: 'Consent & legal' }),
    ).toHaveCount(0);
  });

  test('a signed-in user sees no staff links', async ({ page }) => {
    await signedInHome(page, 'user-nav');
    const nav = await openNav(page);
    await expect(nav.getByRole('link', { name: 'Stories' })).toBeVisible();
    await expect(nav.locator('[data-staff-link]')).toHaveCount(0);
  });

  test('a signed-out visitor sees no staff links', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
    const nav = await openNav(page);
    await expect(nav.getByRole('link', { name: 'Stories' })).toBeVisible();
    await expect(nav.locator('[data-staff-link]')).toHaveCount(0);
  });
});
