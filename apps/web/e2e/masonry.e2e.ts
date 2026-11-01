import { createHash } from 'node:crypto';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { GLYPH_SOURCE } from '../src/lib/card-glyphs';

// Browse's masonry (D55, lib/masonry.ts): the first paint is the server's prediction, each card
// clipped to its predicted rows, and once the page's JavaScript runs, measured heights replace
// it (story-masonry.tsx). The stub API
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
 * The page as it is before its JavaScript runs: the server's HTML and stylesheets, with no
 * script loaded. Not JavaScript turned off, which shows the list in one column (story-masonry.tsx's
 * <noscript>).
 */
const blockScripts = (target: Page | BrowserContext) =>
  target.route('**/*', (route) =>
    route.request().resourceType() === 'script'
      ? route.abort()
      : route.fallback(),
  );

/**
 * What's wrong with the first paint: cards that draw over the next one in their column (where a
 * card's list item clips it, MASONRY_CSS, only its visible part counts), and with `spans`, cards
 * whose predicted span can't hold them and the gap below (a guess too short, which clips a line
 * until the page measures it). With `widths`, at each of those list widths in turn (the list's
 * box set to it, all in the page, so it's quick). One column, in normal flow (a phone, a list
 * too narrow for its text size, a browser without container queries), predicts nothing, so only
 * overlaps count there.
 */
function firstPaintProblems(
  page: Page,
  { widths, spans }: { widths?: number[]; spans: boolean },
) {
  return cards(page).evaluateAll(
    (lis, { widths, spans }) => {
      const ul = lis[0]?.parentElement;
      const box = ul?.parentElement;
      if (!ul || !box) return ['no list'];
      const check = (at: string) => {
        const found: string[] = [];
        const rects = lis.map((li) =>
          (li.firstElementChild as HTMLElement).getBoundingClientRect(),
        );
        const visibleBottom = lis.map((li, i) =>
          getComputedStyle(li).overflowY === 'clip'
            ? Math.min(rects[i].bottom, li.getBoundingClientRect().bottom)
            : rects[i].bottom,
        );
        rects.forEach((a, i) =>
          rects.forEach((b, j) => {
            if (
              Math.round(a.x) === Math.round(b.x) &&
              b.top > a.top &&
              b.top < visibleBottom[i] - 0.5
            )
              found.push(
                `${at}card ${i} ends at ${visibleBottom[i].toFixed(1)}, card ${j} starts at ${b.top.toFixed(1)}`,
              );
          }),
        );
        const style = getComputedStyle(ul);
        if (!spans || style.gridTemplateColumns.split(' ').length === 1)
          return found;
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
    },
    { widths: widths ?? null, spans },
  );
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

interface Paint {
  /** Before the page loads. */
  before?: (page: Page) => Promise<unknown>;
  after: (page: Page) => Promise<unknown>;
  /** Whether the prediction must hold every card (or only nothing may overlap). */
  spans: boolean;
}

const PAINTS: Record<string, Paint> = {
  'as served': {
    after: (page) => page.evaluate(() => document.fonts.ready),
    spans: true,
  },
  'without container queries': {
    after: (page) =>
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
    spans: true,
  },
  '125% text setting': { after: (page) => textSetting(page, 20), spans: true },
  '200% text setting': { after: (page) => textSetting(page, 32), spans: true },
  '200% root text': {
    after: (page) =>
      page.evaluate(() => {
        const style = document.createElement('style');
        style.textContent = 'html { font-size: 200% !important; }';
        document.head.append(style);
        return document.fonts.ready;
      }),
    spans: true,
  },
  // What the prediction can't foresee (Codex review of #163, round 2): DM Sans never loading
  // (the page shows its fallback font, whose widths depend on the machine), and every guess far
  // too short. The cards are clipped, never drawn over the next one.
  'DM Sans blocked': {
    before: (page) => page.route('**/*.woff2', (route) => route.abort()),
    after: (page) => page.evaluate(() => document.fonts.ready),
    spans: false,
  },
  'every guess far too short': {
    after: (page) =>
      cards(page).evaluateAll((lis) => {
        for (const li of lis)
          for (const name of Array.from(li.style))
            if (/^--s\d+$/.test(name)) li.style.setProperty(name, '20');
      }),
    spans: false,
  },
};

// A prediction may leave a gap or clip a card's last line, but no card may draw over the next one
// (Codex review of #72, round 3: 9:16 videos were 35 px short at 1280 px, which a loaded machine
// caught before the measurement landed). Every multi-column device, every story.
test.describe('first paint, before any script runs', () => {
  test.beforeEach(({ page }) => blockScripts(page));

  for (const [paint, { before, after, spans }] of Object.entries(PAINTS))
    test(`no card overlaps the next one in its column (${paint})`, async ({
      page,
    }, info) => {
      test.skip(
        (info.project.use.viewport?.width ?? 0) < 640,
        'one column below 640 px',
      );
      await before?.(page);
      await page.goto('/stories?pages=4');
      await expect(cards(page)).toHaveCount(54);
      await after(page);
      expect(await firstPaintProblems(page, { spans })).toEqual([]);
    });

  // Every list width, pixel by pixel, from the narrowest two-column list to the site's widest,
  // both below the three-column breakpoint (a 1000 px window) and above it (1300 px): cards
  // whose text sits on the edge of a line at some width (a title and excerpt Codex found 2 px
  // short at 688 px), emoji, right-to-left text, em spaces and soft hyphens
  // (`theme=masonry_test`, e2e/stub-api.mjs), and all 54 stories. One device: the widths are set
  // here.
  for (const [paint, { before, after, spans }] of Object.entries(PAINTS))
    test(`no card overlaps at any list width (${paint})`, async ({
      page,
    }, info) => {
      test.skip(
        info.project.name !== 'desktop-1280',
        'the widths are set here',
      );
      const widths = (from: number, to: number) =>
        Array.from({ length: to - from + 1 }, (_, i) => from + i);
      await before?.(page);
      for (const [path, count] of [
        ['/stories?theme=masonry_test', 10],
        ['/stories?pages=4', 54],
      ] as const) {
        for (const [window, list] of [
          [1000, widths(520, 920)],
          [1300, widths(900, 1120)],
        ] as const) {
          await page.setViewportSize({ width: window, height: 900 });
          await page.goto(path);
          await expect(cards(page)).toHaveCount(count);
          await after(page);
          expect(
            await firstPaintProblems(page, { widths: [...list], spans }),
            path,
          ).toEqual([]);
        }
      }
    });
});

// Without JavaScript nothing is ever measured, so nothing may stay clipped: one column in normal
// flow, the whole of every card shown.
test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('the list is one column and no card is clipped', async ({
    page,
  }, info) => {
    test.skip(
      !['ipad-mini-portrait', 'desktop-1280'].includes(info.project.name),
      'one device a layout',
    );
    await page.goto('/stories?theme=masonry_test');
    await expect(cards(page)).toHaveCount(10);
    const layout = await cards(page).evaluateAll((lis) => ({
      columns: getComputedStyle(
        lis[0].parentElement as HTMLElement,
      ).gridTemplateColumns.split(' ').length,
      clipped: lis.filter((li) => getComputedStyle(li).overflowY !== 'visible')
        .length,
    }));
    expect(layout).toEqual({ columns: 1, clipped: 0 });
    expect(await firstPaintProblems(page, { spans: false })).toEqual([]);
  });
});

// The predictions use DM Sans's widths as measured from one font file (lib/card-glyphs.ts). If
// the site serves another (next/font downloads it at build), they must be measured again
// (tools/scripts/card-glyph-widths.mjs).
test('the site serves the DM Sans the card widths were measured from', async ({
  request,
}, info) => {
  test.skip(info.project.name !== 'desktop-1280', 'one device');
  const html = await (await request.get('/stories')).text();
  const sheets = [
    ...html.matchAll(/href="(\/_next\/static\/[^"]+\.css)"/g),
  ].map((m) => m[1]);
  const fonts: string[] = [];
  for (const sheet of new Set(sheets)) {
    const css = await (await request.get(sheet)).text();
    for (const face of css.match(/@font-face\{[^}]*\}/g) ?? []) {
      const src =
        /family:DM Sans;.*url\(\.\.\/media\/([^)]+)\).*unicode-range:U\+\?\?/.exec(
          face,
        );
      if (src) fonts.push(src[1]);
    }
  }
  expect(fonts).toHaveLength(1);
  const font = await request.get(`/_next/static/media/${fonts[0]}`);
  const sha256 = createHash('sha256')
    .update(await font.body())
    .digest('hex');
  expect(sha256).toBe(GLYPH_SOURCE.fontSha256);
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
  const before = await browser.newContext({ ...info.project.use });
  await blockScripts(before);
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
