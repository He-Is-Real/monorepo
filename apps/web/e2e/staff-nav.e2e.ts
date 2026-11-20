import { expect, type Locator, type Page, test } from '@playwright/test';
import { BEHAVIOUR_DEVICES, SCREENSHOT_DEVICES } from './devices';
import { expectAllTargets, expectNoHorizontalOverflow } from './helpers';
import { WEB_SIGNED_IN_URL } from './servers';

// The staff link in the site's main navigation (Joel, 2026-11-14; one "Admin" link, Joel
// 2026-11-20): after the public links, set apart by a thin line, one "Admin" link to the admin
// landing page for Moderators and Admins, current on every admin and moderation page. Nobody else
// sees it: not signed-out people, not Users, and nobody until their role is known. The navigation
// marks itself `data-role-known` once the links are final for the page load (signed out, or
// api-user has answered), so "no staff link" is checked only then. The navigation with the link
// fits every device (the desktop's one row, the tablet's second row, the phone's menu); the
// behaviour runs on one phone and one desktop. The stub api-user (stub-api-user.mjs) makes
// sessions starting `admin` Admins and `moderator` Moderators; everyone else is a User.

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

test('the navigation with the Admin link fits, with 44 px targets', async ({
  page,
}, info) => {
  await useSession(page, 'admin-nav-fit');
  await page.goto(`${WEB_SIGNED_IN_URL}/`);
  const nav = await openNav(page);
  await expect(nav.getByRole('link', { name: 'Admin' })).toBeVisible();
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
    // No link's words break onto a second line, and the public links keep their one row.
    const tops = async (l: Locator) =>
      l.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().top));
    const heights = await nav
      .getByRole('link')
      .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
    for (const h of heights)
      expect(h, 'a link wraps onto two lines').toBeLessThanOrEqual(44.5);
    const t = await tops(nav.locator('li:not([data-staff-links]) > a'));
    for (const top of t)
      expect(
        Math.abs(top - t[0]),
        'the public links split',
      ).toBeLessThanOrEqual(1);
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

test.describe('staff link', () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, info) => {
    test.skip(
      !BEHAVIOUR_DEVICES.includes(info.project.name),
      'one phone and one desktop',
    );
  });

  test('an admin sees one Admin link after the public links; it opens the admin page and stays current on the staff pages', async ({
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
      'Admin',
    ]);
    await expect(nav.getByRole('link', { name: 'Admin' })).not.toHaveAttribute(
      'aria-current',
    );
    await nav.getByRole('link', { name: 'Admin' }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Admin' }),
    ).toBeVisible();

    // Current on the landing page and every staff page, and still the only staff link there.
    for (const [path, title] of [
      ['/admin', 'Admin'],
      ['/moderation', 'Moderation'],
      ['/admin/consent', 'Consent & legal'],
    ] as const) {
      await page.goto(`${WEB_SIGNED_IN_URL}${path}`);
      await expect(
        page.getByRole('heading', { level: 1, name: title }),
      ).toBeVisible();
      nav = await openNav(page);
      await expect(nav).toHaveAttribute('data-role-known', '');
      await expect(nav.locator('[data-staff-link]'), path).toHaveText([
        'Admin',
      ]);
      await expect(
        nav.getByRole('link', { name: 'Admin' }),
        path,
      ).toHaveAttribute('aria-current', 'page');
    }
  });

  test('a moderator sees the Admin link too', async ({ page }) => {
    await signedInHome(page, 'moderator-nav');
    const nav = await openNav(page);
    await expect(nav.locator('[data-staff-link]')).toHaveText(['Admin']);
  });

  test('an admin sees no staff link while their role is unknown', async ({
    page,
  }) => {
    // api-user's answer is held: until it comes, no staff link shows (no flash), then it does.
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    await page.route(
      (url) => url.pathname === '/v1/account',
      async (route) => {
        await held;
        await route.continue();
      },
    );
    await useSession(page, 'admin-nav-held');
    const account = page.waitForRequest(
      (r) => new URL(r.url()).pathname === '/v1/account',
    );
    await page.goto(`${WEB_SIGNED_IN_URL}/`);
    await account;
    const nav = await openNav(page);
    await expect(nav.getByRole('link', { name: 'Stories' })).toBeVisible();
    await expect(nav).not.toHaveAttribute('data-role-known');
    await expect(nav.locator('[data-staff-link]')).toHaveCount(0);
    release();
    await expect(nav).toHaveAttribute('data-role-known', '');
    await expect(nav.locator('[data-staff-link]')).toHaveCount(1);
  });

  test('a signed-in user sees no staff link', async ({ page }) => {
    await signedInHome(page, 'user-nav');
    const nav = await openNav(page);
    await expect(nav).toHaveAttribute('data-role-known', '');
    await expect(nav.getByRole('link', { name: 'Stories' })).toBeVisible();
    await expect(nav.locator('[data-staff-link]')).toHaveCount(0);
  });

  test('a signed-out visitor sees no staff link', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
    const nav = await openNav(page);
    await expect(nav).toHaveAttribute('data-role-known', '');
    await expect(nav.getByRole('link', { name: 'Stories' })).toBeVisible();
    await expect(nav.locator('[data-staff-link]')).toHaveCount(0);
  });
});
