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

/**
 * What's wrong with the first paint: cards that overlap the next one in their column, and cards
 * whose predicted span can't hold them and the gap below (a prediction too short, though the
 * last card in a column has nothing to overlap). With `widths`, at each of those list widths in
 * turn (the list's box set to it, all in the page, so it's quick). One column, in normal flow
 * (a phone, a list too narrow for its text size, a browser without container queries), predicts
 * nothing, so only overlaps count there.
 */
function firstPaintProblems(page: Page, widths?: number[]) {
  return cards(page).evaluateAll((lis, widths) => {
    const ul = lis[0]?.parentElement;
    const box = ul?.parentElement;
    if (!ul || !box) return ['no list'];
    const check = (at: string) => {
      const found: string[] = [];
      const rects = lis.map((li) =>
        (li.firstElementChild as HTMLElement).getBoundingClientRect(),
      );
      rects.forEach((a, i) =>
        rects.forEach((b, j) => {
          if (
            Math.round(a.x) === Math.round(b.x) &&
            b.top > a.top &&
            b.top < a.bottom - 0.5
          )
            found.push(
              `${at}card ${i} ends at ${a.bottom.toFixed(1)}, card ${j} starts at ${b.top.toFixed(1)}`,
            );
        }),
      );
      const style = getComputedStyle(ul);
      if (style.gridTemplateColumns.split(' ').length === 1) return found;
      const row = parseFloat(style.gridAutoRows);
      const gap = parseFloat(style.columnGap);
      lis.forEach((li, i) => {
        const span = Number(
          /span (\d+)/.exec(getComputedStyle(li).gridRowEnd)?.[1],
        );
        if (span * row < rects[i].height + gap - 0.5)
          found.push(
            `${at}card ${i} is ${rects[i].height.toFixed(1)} px tall, its ${span} rows of ${row} px hold ${(span * row - gap).toFixed(1)}`,
          );
      });
      return found;
    };
    if (!widths) return check('');
    const problems = widths.flatMap((width) => {
      box.style.width = `${width}px`;
      return check(`list ${width} px: `);
    });
    box.style.width = '';
    return problems;
  }, widths ?? null);
}

/**
 * Whether every card spans exactly its measured height plus the gap (`--m`, story-masonry.tsx):
 * the page has measured them all. Spans are in 4 px rows with a 24 px gap at the default 16 px
 * text size (ROW_UNIT and GAP, lib/masonry.ts), in rem.
 */
function allMeasured(page: Page) {
  return cards(page).evaluateAll((lis) => {
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    return lis.every((li) => {
      const height = (
        li.firstElementChild as HTMLElement
      ).getBoundingClientRect().height;
      const span = Math.ceil(((height * 16) / rem + 24) / 4);
      return li.style.getPropertyValue('--m') === String(span);
    });
  });
}

/**
 * The ways a first paint can differ from the one the bands predict: as served; in a browser
 * without container queries (Codex review of #163: such a browser kept the narrowest band and
 * overlapped by 86 px at 768 px), done here by deleting the stylesheet's `@container` rules; and
 * with larger text, as a reader's text-size setting makes it (rem and the breakpoints' em grow:
 * at 125% the masonry keeps two columns, scaled, and at 200% (WCAG 1.4.4) the list is one column)
 * and as e2e/helpers.ts's enlargeText does (only rem grows; that helper needs JavaScript, so the
 * same style is added here).
 */
async function textSetting(page: Page, px: number) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Page.setFontSizes', { fontSizes: { standard: px } });
  await page.evaluate(() => document.fonts.ready);
}

const PAINTS = {
  'as served': (page: Page) => page.evaluate(() => document.fonts.ready),
  'without container queries': (page: Page) =>
    page.evaluate(() => {
      for (const sheet of Array.from(document.styleSheets)) {
        const drop = (list: CSSRuleList, remove: (i: number) => void) => {
          for (let i = list.length - 1; i >= 0; i--) {
            const rule = list[i];
            if (rule instanceof CSSContainerRule) remove(i);
            else if (rule instanceof CSSGroupingRule)
              drop(rule.cssRules, (j) => rule.deleteRule(j));
          }
        };
        drop(sheet.cssRules, (i) => sheet.deleteRule(i));
      }
    }),
  '125% text setting': (page: Page) => textSetting(page, 20),
  '200% text setting': (page: Page) => textSetting(page, 32),
  '200% root text': (page: Page) =>
    page.evaluate(() => {
      const style = document.createElement('style');
      style.textContent = 'html { font-size: 200% !important; }';
      document.head.append(style);
      return document.fonts.ready;
    }),
} satisfies Record<string, (page: Page) => Promise<unknown>>;

// The prediction may leave a gap but must never overlap the next card (Codex review of #72,
// round 3: 9:16 videos were 35 px short at 1280 px, which a loaded machine caught before the
// measurement landed). Every multi-column device, every story.
test.describe('first paint, before any measuring', () => {
  test.use({ javaScriptEnabled: false });

  for (const [paint, prepare] of Object.entries(PAINTS))
    test(`no card overlaps the next one in its column (${paint})`, async ({
      page,
    }, info) => {
      test.skip(
        (info.project.use.viewport?.width ?? 0) < 640,
        'one column below 640 px',
      );
      await page.goto('/stories?pages=4');
      await expect(cards(page)).toHaveCount(54);
      await prepare(page);
      expect(await firstPaintProblems(page)).toEqual([]);
    });

  // Every list width, pixel by pixel, from the narrowest two-column list to the site's widest,
  // both below the three-column breakpoint (a 1000 px window) and above it (1300 px): cards
  // whose text sits on the edge of a line at some width (a title and excerpt Codex found 2 px
  // short at 688 px), emoji and right-to-left text (`tag=masonry-test`, e2e/stub-api.mjs), and
  // all 54 stories. One device: the widths are set here.
  for (const [paint, prepare] of Object.entries(PAINTS))
    test(`no card overlaps at any list width (${paint})`, async ({
      page,
    }, info) => {
      test.skip(
        info.project.name !== 'desktop-1280',
        'the widths are set here',
      );
      const widths = (from: number, to: number) =>
        Array.from({ length: to - from + 1 }, (_, i) => from + i);
      for (const [path, count] of [
        ['/stories?tag=masonry-test', 8],
        ['/stories?pages=4', 54],
      ] as const) {
        for (const [window, list] of [
          [1000, widths(520, 920)],
          [1300, widths(900, 1120)],
        ] as const) {
          await page.setViewportSize({ width: window, height: 900 });
          await page.goto(path);
          await expect(cards(page)).toHaveCount(count);
          await prepare(page);
          expect(await firstPaintProblems(page, [...list]), path).toEqual([]);
        }
      }
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

  // Measured: every card spans its own height plus the gap, in rows (--m, story-masonry.tsx).
  await page.goto('/stories');
  await expect(cards(page)).toHaveCount(15);
  await page.evaluate(() => document.fonts.ready);
  await expect.poll(() => allMeasured(page)).toBe(true);
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
