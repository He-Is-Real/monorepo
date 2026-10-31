import { expect, type Page, test } from '@playwright/test';
import {
  expectAllTargets,
  expectNoHorizontalOverflow,
  expectTarget,
} from './helpers';

// T7: states that only appear after a tap or a failure, on every device in the matrix (light;
// the colour scheme doesn't change sizes): the phone menu, "More themes", "Show more stories" and
// a failed load's Try again fit the screen, with 44 px targets. Their behaviour (focus, Escape,
// loading) is in pages.e2e.ts on one phone and one desktop.

const cards = (page: Page) => page.locator('main ul.masonry > li');

test('the phone menu, open, fits with full-size targets', async ({
  page,
}, info) => {
  const width = info.project.use.viewport?.width ?? 0;
  test.skip(width >= 640, 'the menu button shows below 640 px only');
  await page.goto('/');
  const menu = page.getByRole('button', { name: 'Menu' });
  await expectTarget(page, menu);
  await menu.click();
  const nav = page.getByRole('navigation', { name: 'Menu' });
  await expect(nav).toBeVisible();
  await expectNoHorizontalOverflow(page);
  // The panel's links and its "Share your story" button are in the header.
  await expectAllTargets(page);
});

test('“More themes”, open, fits with full-size targets', async ({ page }) => {
  await page.goto('/stories');
  const more = page.locator('main [data-more-themes]');
  await more.locator('summary').click();
  await expect(more).toHaveAttribute('open');
  await expect(more.getByRole('link').first()).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectAllTargets(page);
});

test('“Show more stories” fits with a full-size target', async ({ page }) => {
  await page.goto('/stories?pages=3');
  await expect(cards(page)).toHaveCount(45);
  const more = page.getByRole('button', { name: 'Show more stories' });
  await expectTarget(page, more);
  await expectNoHorizontalOverflow(page);
});

test('a failed load’s Try again fits with a full-size target', async ({
  page,
}) => {
  await page.goto('/stories');
  await expect(cards(page)).toHaveCount(15);
  // Server actions are POSTs to the page: fail them all.
  await page.route('**/stories*', (route) =>
    route.request().method() === 'POST'
      ? route.abort('internetdisconnected')
      : route.continue(),
  );
  await page.evaluate(() =>
    window.scrollTo(0, document.documentElement.scrollHeight),
  );
  await expect(page.getByText('More stories couldn’t load.')).toBeVisible();
  await expectTarget(page, page.getByRole('button', { name: 'Try again' }));
  await expectNoHorizontalOverflow(page);
});

// Readable line length (AGENTS.md; Joel, R1 = A, 2026-10-24: the reading column): body text
// (15 px and up) runs to at most 80 characters per rendered line on one device per layout band,
// About (kept wide by Joel) included. Only text a reader sees: FAQ answers opened and
// "Continue reading" expanded first; hidden, collapsed, aria-hidden and screen-reader-only
// text skipped. Small print (under 15 px: the Scripture
// copyright, the cookie-table note, captions) is exempt.
const LINE_LIMIT = 80;
const BANDS = [
  'small-tablet-portrait', // 600
  'ipad-mini-portrait', // 768
  'ipad-pro-12.9-portrait', // 1024
  'desktop-1280',
  'desktop-2560',
];

test(`body text runs to at most ${LINE_LIMIT} characters a line`, async ({
  page,
}, info) => {
  test.skip(!BANDS.includes(info.project.name), 'one device per layout band');
  const tooLong: string[] = [];
  for (const path of [
    '/',
    '/stories',
    '/stories/long-story',
    '/stories/browse-test-02',
    '/stories/video-story',
    '/about',
    '/greatest-story',
    '/get-ready',
    '/next-steps',
    '/faqs',
    '/contact',
    '/privacy',
    '/terms',
    '/donate',
  ]) {
    await page.goto(path);
    // Open every FAQ answer and expand a long story.
    await page
      .locator('main h3 button[aria-expanded="false"]')
      .evaluateAll((questions) =>
        questions.forEach((q) => (q as HTMLButtonElement).click()),
      );
    const more = page.getByRole('button', { name: 'Continue reading' });
    if (await more.count()) await more.click();
    await page.evaluate(() => document.fonts.ready);
    const lines = await page.evaluate((limit) => {
      const out: string[] = [];
      const range = document.createRange();
      const seen = (el: Element) =>
        el.checkVisibility({
          opacityProperty: true,
          visibilityProperty: true,
        }) && !el.closest('[aria-hidden="true"], .sr-only, [hidden]');
      // Each rendered line of a text block: its text nodes, inline elements included.
      const blocks = new Map<Element, Map<number, number>>();
      const walker = document.createTreeWalker(
        document.querySelector('main') ?? document.body,
        NodeFilter.SHOW_TEXT,
      );
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement;
        if (!parent || !seen(parent)) continue;
        if (parseFloat(getComputedStyle(parent).fontSize) < 15) continue;
        let block: Element = parent;
        while (
          block.parentElement &&
          getComputedStyle(block).display.startsWith('inline')
        )
          block = block.parentElement;
        const perLine = blocks.get(block) ?? new Map<number, number>();
        blocks.set(block, perLine);
        const text = node.textContent ?? '';
        for (let i = 0; i < text.length; i++) {
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          const rect = range.getBoundingClientRect();
          if (rect.width === 0) continue;
          const top = Math.round(rect.top);
          perLine.set(top, (perLine.get(top) ?? 0) + 1);
        }
      }
      for (const [block, perLine] of blocks) {
        const longest = Math.max(0, ...perLine.values());
        if (longest > limit)
          out.push(
            `${longest} chars: "${(block.textContent ?? '').trim().slice(0, 50)}"`,
          );
      }
      return out;
    }, LINE_LIMIT);
    tooLong.push(...lines.map((l) => `${path} ${l}`));
  }
  expect(tooLong, `lines over ${LINE_LIMIT} characters`).toEqual([]);
});
