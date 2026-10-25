import { expect, type Locator, type Page, test } from '@playwright/test';
import { expectAllTargets, expectNoHorizontalOverflow, shots } from './helpers';

// D72: a story card says NEW while its story was published less than 7 days ago, decided by
// web's server (nothing per person, nothing computed in the browser). The e2e servers' clock is
// pinned (E2E_NOW in servers.ts, 2026-10-25T12:00:00Z) and the stub's `tag=new-test` stories
// are dated around it, so the 7-day boundary is exact, locally and in CI. Every device, both
// colour schemes.

const LIST = '/stories?tag=new-test';
const LABEL = 'New: published in the last week';
const NEW = ['New test: 2 days old', 'New test: 1 second under 7 days old'];
const NOT_NEW = ['New test: exactly 7 days old', 'New test: 8 days old'];

const card = (page: Page, title: string) =>
  page.locator('article').filter({
    has: page.getByRole('heading', { name: title, exact: true }),
  });
const BADGE = '[data-new-badge]';
const badgeIn = (scope: Locator) => scope.locator(BADGE);

type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;

/** The badge sits inside its card, clear of the media area (play button, player). */
async function expectBadgePlaced(c: Locator) {
  const badge = await badgeIn(c).boundingBox();
  const article = await c.boundingBox();
  expect(badge && article).toBeTruthy();
  if (!badge || !article) return;
  expect(badge.x).toBeGreaterThanOrEqual(article.x);
  expect(badge.x + badge.width).toBeLessThanOrEqual(article.x + article.width);
  const media = c.locator('[data-card-media]');
  if ((await media.count()) === 0) return; // a written story without a picture
  const box = await media.boundingBox();
  expect(box && overlaps(badge, box), 'badge covers the media').toBe(false);
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} scheme`, () => {
    test.use({ colorScheme: scheme });

    test('cards under 7 days old say NEW; 7 days and older don’t', async ({
      page,
    }, info) => {
      const hydrationErrors: string[] = [];
      page.on('console', (m) => {
        if (m.type() === 'error' && /hydrat/i.test(m.text()))
          hydrationErrors.push(m.text());
      });
      await page.goto(LIST);
      for (const title of NEW) {
        const c = card(page, title);
        await expect(badgeIn(c)).toHaveText(`NEW${LABEL}`);
        await expect(
          badgeIn(c).getByText('NEW', { exact: true }),
        ).toBeVisible();
        await expectBadgePlaced(c);
      }
      for (const title of NOT_NEW) {
        await expect(card(page, title)).toBeVisible();
        await expect(badgeIn(card(page, title))).toHaveCount(0);
      }
      // The play buttons are still whole 44 px targets, and nothing scrolls sideways.
      await expectAllTargets(page);
      await expectNoHorizontalOverflow(page);
      expect(hydrationErrors).toEqual([]);
      await shots(page, info.project.name, scheme, 'new-badge');
    });

    test('home and related stories show the badge too, without sideways scroll', async ({
      page,
    }, info) => {
      // Home's newest cards are a few days old on the pinned clock.
      await page.goto('/');
      const first = page
        .locator('article')
        .filter({ has: page.locator(BADGE) })
        .first();
      await expect(first).toBeVisible();
      await expectBadgePlaced(first);
      await expectNoHorizontalOverflow(page);
      await expectAllTargets(page);

      // Related: cards from 1024 px, a small list below; whichever is shown has the badge.
      await page.goto('/stories/long-words');
      const related = page.getByRole('region', { name: 'Related stories' });
      await expect(related.locator(`${BADGE}:visible`).first()).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await shots(page, info.project.name, scheme, 'related-new-badge');
    });
  });
}

test('the badge is in the server-rendered HTML', async ({ request }, info) => {
  test.skip(info.project.name !== 'desktop-1280', 'one device');
  const html = await (await request.get(LIST)).text();
  expect(html.split(LABEL)).toHaveLength(NEW.length + 1);
});
