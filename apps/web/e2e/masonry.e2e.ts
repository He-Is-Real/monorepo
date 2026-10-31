import { expect, type Page, test } from '@playwright/test';

// Browse's masonry (D55, lib/masonry.ts): the first paint is the server's prediction, and once
// the page's JavaScript runs, measured heights replace it (story-masonry.tsx). The stub API
// serves 54 published stories (e2e/stub-api.mjs).

const cards = (page: Page) => page.locator('main ul.masonry > li');

/** Each card's top and bottom in the page, once the fonts have loaded. */
async function boxes(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  return cards(page).evaluateAll((lis) =>
    lis.map((li, i) => {
      const r = (li.firstElementChild as HTMLElement).getBoundingClientRect();
      return {
        i,
        x: Math.round(r.x),
        top: r.top + window.scrollY,
        bottom: r.bottom + window.scrollY,
      };
    }),
  );
}

// The prediction may leave a gap but must never overlap the next card (Codex review of #72,
// round 3: 9:16 videos were 35 px short at 1280 px, which a loaded machine caught before the
// measurement landed). Every multi-column device, every story.
test.describe('first paint, before any measuring', () => {
  test.use({ javaScriptEnabled: false });

  test('no card overlaps the next one in its column', async ({
    page,
  }, info) => {
    test.skip(
      (info.project.use.viewport?.width ?? 0) < 640,
      'one column below 640 px',
    );
    await page.goto('/stories?pages=4');
    await expect(cards(page)).toHaveCount(54);
    const all = await boxes(page);
    const overlaps: string[] = [];
    for (const a of all)
      for (const b of all)
        if (a.x === b.x && b.top > a.top && b.top < a.bottom - 0.5)
          overlaps.push(
            `card ${a.i} ends at ${a.bottom.toFixed(1)}, card ${b.i} starts at ${b.top.toFixed(1)}`,
          );
    expect(overlaps).toEqual([]);
  });
});

/**
 * Joel, 2026-10-31 (option B, "guess better"): the cards on the first screen barely move when
 * the measured heights replace the prediction. A person can tap a card before the page's
 * JavaScript runs; if it then jumps, the tap hits a gap or the wrong story, and the page scores
 * worse for layout shift. Before the fix they moved by up to 216 px at 768 px wide.
 *
 * 20 px is under half of the smallest thing on a card a person taps (the 44 px heart and play
 * buttons), so a tap aimed at its middle still lands on it. Only the list's first screenful
 * counts (the cards that start less than a screen below its top): nothing further down can be
 * tapped, or seen to move, before a person scrolls, and the measuring is long done by then. Each
 * card's place is measured from the list's top, so only the masonry's own movement counts. One device per layout: a phone (one column, no predicted
 * spans), the two-column band at 768 px and an unfolded foldable, and desktop's three columns.
 */
const MOST_MOVEMENT = 20;
const SHIFT_DEVICES = [
  'phone-320',
  'ipad-mini-portrait',
  'galaxy-z-fold5-unfolded',
  'desktop-1280',
];

test('cards on the first screen barely move once the page measures them', async ({
  browser,
  page,
}, info) => {
  test.skip(!SHIFT_DEVICES.includes(info.project.name), 'one device a layout');
  // The first paint: the server's page as it is before any script runs.
  const before = await browser.newContext({
    ...info.project.use,
    javaScriptEnabled: false,
  });
  const first = await before.newPage();
  await first.goto('/stories');
  await expect(cards(first)).toHaveCount(15);
  const predicted = await boxes(first);
  await before.close();

  // Measured: every card spans its own height plus the gap, in 4 px rows (--m, story-masonry.tsx;
  // GAP and ROW_UNIT in lib/masonry.ts).
  await page.goto('/stories');
  await expect(cards(page)).toHaveCount(15);
  await page.evaluate(() => document.fonts.ready);
  await expect
    .poll(() =>
      cards(page).evaluateAll((lis) =>
        lis.every((li) => {
          const card = li.firstElementChild as HTMLElement;
          const span = Math.ceil(
            (card.getBoundingClientRect().height + 24) / 4,
          );
          return li.style.getPropertyValue('--m') === String(span);
        }),
      ),
    )
    .toBe(true);
  const measured = await boxes(page);

  const screen = info.project.use.viewport?.height ?? 0;
  const top = (all: typeof predicted, i: number) => all[i].top - all[0].top;
  const moves = predicted
    .filter((card) => top(predicted, card.i) < screen)
    .map((card) => ({
      card: card.i,
      moved: Math.round(top(predicted, card.i) - top(measured, card.i)),
    }));
  expect(moves.length).toBeGreaterThan(1);
  expect(moves.filter((m) => Math.abs(m.moved) > MOST_MOVEMENT)).toEqual([]);
});
