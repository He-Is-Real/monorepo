import { expect, type Locator, type Page, test } from '@playwright/test';
import {
  enlargeText,
  expectAllTargets,
  expectNoHorizontalOverflow,
  shots,
} from './helpers';

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

/** `inner` lies wholly inside `outer`'s box (half a pixel for rounding). */
async function expectInside(inner: Locator, outer: Locator, what: string) {
  const a = await inner.boundingBox();
  const b = await outer.boundingBox();
  expect(a && b, what).toBeTruthy();
  if (!a || !b) return;
  expect(
    {
      left: a.x >= b.x - 0.5,
      right: a.x + a.width <= b.x + b.width + 0.5,
    },
    `${what}: ${Math.round(a.x)}–${Math.round(a.x + a.width)} px in ${Math.round(b.x)}–${Math.round(b.x + b.width)} px`,
  ).toEqual({ left: true, right: true });
}

/** The card's label (badge included) is clear of the card's heart (top right, heart-button.tsx). */
async function expectClearOfHeart(c: Locator, what: string) {
  const label = await c.locator('[data-card-label]').boundingBox();
  const heart = await c.locator('[data-heart]').boundingBox();
  expect(label && heart, what).toBeTruthy();
  if (!label || !heart) return;
  expect(overlaps(label, heart), `${what}: label covers the heart`).toBe(false);
}

/** The badge sits inside its card, clear of the heart and the media area (play button, player). */
async function expectBadgePlaced(c: Locator) {
  const badge = await badgeIn(c).boundingBox();
  const article = await c.boundingBox();
  expect(badge && article).toBeTruthy();
  if (!badge || !article) return;
  expect(badge.x).toBeGreaterThanOrEqual(article.x);
  expect(badge.x + badge.width).toBeLessThanOrEqual(article.x + article.width);
  await expectClearOfHeart(c, 'badge');
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

// WCAG 1.4.4: at 200% text the card's label (the badge and "Video · 0:12") wraps inside the card
// instead of being clipped, and the phones' related list puts its text under the thumbnail.
// One scheme: colours don't change the layout. The boxes are checked on every device; the whole
// page's width at 200% only on the 320 px phone, as in text-zoom.e2e.ts.
test.describe('200% text', () => {
  test.beforeEach(({ page }) => enlargeText(page));
  const pageFits = async (page: Page, project: string) => {
    if (project === 'phone-320') await expectNoHorizontalOverflow(page);
  };

  test('the badge and the whole label stay inside the card', async ({
    page,
  }, info) => {
    await page.goto(LIST);
    for (const title of [...NEW, ...NOT_NEW]) {
      const c = card(page, title);
      const label = c.locator('[data-card-label]');
      await expectInside(label, c, `${title}: label`);
      // Nothing inside the label is cut off (the duration included).
      expect(
        await label.evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
      await expectClearOfHeart(c, title);
      if (NEW.includes(title))
        await expectInside(badgeIn(c), c, `${title}: badge`);
    }
    await expect(
      card(page, 'New test: 2 days old').getByText('Video · 0:12'),
    ).toBeVisible();
    await pageFits(page, info.project.name);
  });

  test('related stories keep the badge inside their box', async ({
    page,
  }, info) => {
    await page.goto('/stories/long-words');
    const related = page.getByRole('region', { name: 'Related stories' });
    const badges = related.locator(`${BADGE}:visible`);
    await expect(badges.first()).toBeVisible();
    for (const badge of await badges.all())
      await expectInside(badge, related, 'related badge');
    await pageFits(page, info.project.name);
  });
});
