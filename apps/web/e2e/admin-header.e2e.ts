import { randomUUID } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';
import { BEHAVIOUR_DEVICES } from './devices';
import { WEB_SIGNED_IN_URL } from './servers';

// The admin and moderation pages share one header (Joel, 2026-11-17): the admin pages' links, the
// h1 and the description sit in the site's default container on every page, so nothing jumps
// sideways when an admin switches pages, whether the page scrolls or not and however wide its
// content is. Each page's own "fits the screen" checks run on every device; this behaviour runs
// on one phone and one desktop. The stub api-user (stub-api-user.mjs) makes sessions starting
// `admin` Admins.

const PAGES = [
  ['/admin/limits', 'Submission limits'],
  ['/admin/consent', 'Consent & legal'],
  ['/admin/themes', 'Themes'],
  ['/moderation', 'Moderation'],
] as const;

type Box = { x: number; width: number };

/** Where the admin pages' links and the h1 are on `path`, once the page has loaded. */
async function header(page: Page, path: string, title: string) {
  await page.goto(`${WEB_SIGNED_IN_URL}${path}`);
  const nav = page.getByRole('navigation', { name: 'Admin pages' });
  const h1 = page.getByRole('heading', { level: 1, name: title });
  // The role is known (an Admin's links are all there), and the page's content has loaded.
  await expect(nav.getByRole('link', { name: 'Staff' })).toBeVisible();
  await expect(h1).toBeVisible();
  const box = async (l: typeof nav): Promise<Box> => {
    const b = await l.boundingBox();
    if (!b) throw new Error(`${path}: not rendered`);
    return { x: b.x, width: b.width };
  };
  return { nav: await box(nav), h1: await box(h1) };
}

test.describe('admin header', () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, info) => {
    test.skip(
      !BEHAVIOUR_DEVICES.includes(info.project.name),
      'one phone and one desktop',
    );
  });

  test('the admin links and the heading stay in the same place on every admin page', async ({
    page,
  }) => {
    await page.addInitScript(
      (s) => window.localStorage.setItem('e2e-session', s),
      `admin-${randomUUID().slice(0, 8)}`,
    );
    const [first, ...rest] = PAGES;
    const expected = await header(page, ...first);
    for (const [path, title] of rest) {
      const got = await header(page, path, title);
      for (const part of ['nav', 'h1'] as const) {
        expect(got[part].x, `${path}: ${part} moved sideways`).toBeCloseTo(
          expected[part].x,
          0,
        );
        expect(got[part].width, `${path}: ${part} changed width`).toBeCloseTo(
          expected[part].width,
          0,
        );
      }
    }
  });
});
