import { randomUUID } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';
import { BEHAVIOUR_DEVICES } from './devices';
import { WEB_SIGNED_IN_URL } from './servers';

// The admin and moderation pages share one header (Joel, 2026-11-17), centred (OQ-4 D, Joel
// 2026-11-19): the admin pages' links, the h1 and the description are centred in the site's
// default container on every page, so nothing jumps sideways when an admin switches pages,
// whether the page scrolls or not and however wide its content is; each page's content is
// centred under them. Each page's own "fits the screen" checks run on every device; this
// behaviour runs on one phone and one desktop. The stub api-user (stub-api-user.mjs) makes
// sessions starting `admin` Admins.

const PAGES = [
  ['/admin', 'Admin'],
  ['/admin/limits', 'Submission limits'],
  ['/admin/consent', 'Consent & legal'],
  ['/admin/themes', 'Themes'],
  ['/admin/staff', 'Staff'],
  ['/admin/block-list', 'Block list'],
  ['/moderation', 'Moderation'],
] as const;

type Box = { x: number; width: number };

/**
 * Where the admin pages' links, the h1's words and the content are on `path`, once the page has
 * loaded, and the middle of the page (less the scrollbar's gutter it keeps).
 */
async function header(page: Page, path: string, title: string) {
  await page.goto(`${WEB_SIGNED_IN_URL}${path}`);
  const nav = page.getByRole('navigation', { name: 'Admin pages' });
  const h1 = page.getByRole('heading', { level: 1, name: title });
  // The role is known (an Admin's links are all there), and the page's content has loaded.
  await expect(nav.getByRole('link', { name: 'Staff' })).toBeVisible();
  await expect(h1).toBeVisible();
  // The links' and heading's words are measured, so the site's font must have loaded.
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  // What is drawn, not the block it sits in: the links' row and the heading's words.
  const extent = (sel: string, words: boolean) =>
    page
      .locator(sel)
      .first()
      .evaluate((el, w) => {
        const rects = w
          ? (() => {
              const r = document.createRange();
              r.selectNodeContents(el);
              return [r.getBoundingClientRect()];
            })()
          : [...el.querySelectorAll('a')].map((a) => a.getBoundingClientRect());
        const left = Math.min(...rects.map((r) => r.left));
        const right = Math.max(...rects.map((r) => r.right));
        return { x: left, width: right - left };
      }, words);
  const content = await page.locator('[data-admin-content]').boundingBox();
  if (!content) throw new Error(`${path}: no content`);
  return {
    nav: await extent('nav[aria-label="Admin pages"] ul', false),
    h1: await extent('main h1', true),
    content: { x: content.x, width: content.width } satisfies Box,
    // The page's own width: the root's clientWidth leaves out the scrollbar gutter it keeps.
    middle: await page.locator('main[data-admin-page]').evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.left + r.width / 2;
    }),
  };
}

const middleOf = (b: Box) => b.x + b.width / 2;

test.describe('admin header', () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, info) => {
    test.skip(
      !BEHAVIOUR_DEVICES.includes(info.project.name),
      'one phone and one desktop',
    );
  });

  test('the admin links and the heading stay centred, in the same place, on every admin page, with the content centred under them', async ({
    page,
  }) => {
    await page.addInitScript(
      (s) => window.localStorage.setItem('e2e-session', s),
      `admin-${randomUUID().slice(0, 8)}`,
    );
    const [first] = PAGES;
    const expected = await header(page, ...first);
    for (const [path, title] of PAGES) {
      const got = await header(page, path, title);
      for (const part of ['nav', 'content'] as const)
        expect(
          middleOf(got[part]),
          `${path}: ${part} isn't centred`,
        ).toBeCloseTo(got.middle, 0);
      expect(middleOf(got.h1), `${path}: h1 isn't centred`).toBeCloseTo(
        got.middle,
        0,
      );
      // The links are the same on every page, so they don't move at all.
      expect(got.nav.x, `${path}: the links moved sideways`).toBeCloseTo(
        expected.nav.x,
        0,
      );
      expect(got.nav.width, `${path}: the links changed width`).toBeCloseTo(
        expected.nav.width,
        0,
      );
    }
  });

  test('the current page in the staff menu has the teal line under it, and no other link does', async ({
    page,
  }) => {
    await page.addInitScript(
      (s) => window.localStorage.setItem('e2e-session', s),
      `admin-${randomUUID().slice(0, 8)}`,
    );
    const brand = await page.goto(`${WEB_SIGNED_IN_URL}/admin`).then(() =>
      page.evaluate(() => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--brand)';
        document.body.append(probe);
        const c = getComputedStyle(probe).color;
        probe.remove();
        return c;
      }),
    );
    const lineOf = (el: Element) => {
      const a = getComputedStyle(el, '::after');
      return {
        // Drawn at all (generated content, laid out, visible), then opaque and at least 2 px
        // by something wide: computed opacity, size and colour alone stay set without content.
        shown:
          a.content !== 'none' &&
          a.content !== 'normal' &&
          a.display !== 'none' &&
          a.visibility === 'visible' &&
          a.opacity === '1' &&
          parseFloat(a.height) >= 2 &&
          parseFloat(a.width) > 0,
        colour: a.backgroundColor,
      };
    };
    for (const [path, title] of PAGES.filter(([, t]) => t !== 'Admin')) {
      await page.goto(`${WEB_SIGNED_IN_URL}${path}`);
      const nav = page.getByRole('navigation', { name: 'Admin pages' });
      await expect(nav.getByRole('link', { name: 'Staff' })).toBeVisible();
      for (const link of await nav.getByRole('link').all()) {
        const name = (await link.textContent())?.trim();
        const line = await link.evaluate(lineOf);
        if (name === title) {
          await expect(link, path).toHaveAttribute('aria-current', 'page');
          expect(line.shown, `${path}: ${name} has no line`).toBe(true);
          expect(line.colour, `${path}: ${name}'s line isn't teal`).toBe(brand);
        } else {
          expect(line.shown, `${path}: ${name} has a line`).toBe(false);
        }
      }
    }
  });
});
