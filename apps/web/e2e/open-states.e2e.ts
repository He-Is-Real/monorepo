import { expect, type Page, test } from '@playwright/test';
import {
  expectAllTargets,
  expectNoHorizontalOverflow,
  expectTarget,
} from './helpers';

// T7: states that only appear after a tap or a failure, on every device in the matrix (light;
// the colour scheme doesn't change sizes): the phone menu, "More tags", "Show more stories" and
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

test('“More tags”, open, fits with full-size targets', async ({ page }) => {
  await page.goto('/stories');
  const more = page.locator('main details', { hasText: 'More tags' });
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

// Readable line length (AGENTS.md): at most 80 characters per line, checked on the widest
// screen, where lines are longest. Characters are counted on each rendered line of every text
// block (one without blocks inside), with FAQ answers open.
test('lines stay readable on the widest screen: at most 80 characters', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'desktop-2560', 'the widest screen');
  const tooLong: string[] = [];
  for (const path of [
    '/',
    '/stories',
    '/stories/long-story',
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
    await page
      .getByRole('main')
      .getByRole('button')
      .evaluateAll((buttons) =>
        buttons
          .filter((b) => b.getAttribute('aria-expanded') === 'false')
          .forEach((b) => (b as HTMLButtonElement).click()),
      );
    await page.evaluate(() => document.fonts.ready);
    const long = await page.evaluate(() => {
      const out: string[] = [];
      const blocks = Array.from(document.querySelectorAll('main *')).filter(
        (el) =>
          el.checkVisibility() &&
          !el.closest('.sr-only') &&
          getComputedStyle(el).display !== 'inline' &&
          Array.from(el.childNodes).some(
            (n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim(),
          ) &&
          !Array.from(el.children).some(
            (c) => getComputedStyle(c).display !== 'inline',
          ),
      );
      const range = document.createRange();
      for (const el of blocks) {
        const lines = new Map<number, number>();
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const text = node.textContent ?? '';
          for (let i = 0; i < text.length; i++) {
            range.setStart(node, i);
            range.setEnd(node, i + 1);
            const rect = range.getBoundingClientRect();
            if (rect.width === 0) continue;
            const top = Math.round(rect.top);
            lines.set(top, (lines.get(top) ?? 0) + 1);
          }
        }
        const longest = Math.max(0, ...lines.values());
        if (longest > 80)
          out.push(
            `${longest} chars: "${(el.textContent ?? '').trim().slice(0, 50)}"`,
          );
      }
      return out;
    });
    tooLong.push(...long.map((l) => `${path} ${l}`));
  }
  expect(tooLong, 'lines over 80 characters').toEqual([]);
});
