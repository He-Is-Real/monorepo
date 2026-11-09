import type { StorySummary } from './browse';
import { cardLabel } from './card-label';
import { GLYPH_CHARS, GLYPH_EMS, KERN_EMS } from './card-glyphs';
import { CARD, type TextStyle } from './card-metrics';
import { audioSize, cardAspect } from './shape';

// D55: balanced masonry from predicted heights. A card's height is its fixed parts plus its
// media (card width ÷ the clamped shape, D53) plus its text lines. Each card goes into the
// currently shortest column; the DOM stays in date order and CSS grid places the cards
// (`grid-auto-flow: dense`, a column and a row span per card). In the browser, measured heights
// replace the predicted spans (story-masonry.tsx); cards never change column.
//
// The server can't know the screen, so it predicts every card for every band of list widths
// (BANDS: the list's width in steps of BAND_STEP px per card), and the stylesheet this file
// writes (MASONRY_CSS) picks the band the list is in with a container query. Within a band the
// media is predicted at its widest card and the text at its narrowest, so a prediction errs tall
// by a few pixels. Before the bands, one guess covered 640 to 1023 px and cards jumped up by 100
// px or more once measured (Joel, 2026-10-31, option B: guess better).
//
// Cards never overlap, whatever the guess: each card's list item fills the rows it spans and
// clips what doesn't fit (MASONRY_CSS). A guess too short (text in a fallback font while DM Sans
// loads, or if it never does; text the table can't foresee) clips the card's last line until the
// page measures it; it can't draw over the next card (Codex review of #163, round 2). Measured
// spans always hold the card, so nothing is clipped once measured. Without JavaScript nothing is
// ever measured, so the list is one column in normal flow, nothing predicted or clipped
// (story-masonry.tsx's <noscript>).
//
// Text is wrapped as the browser wraps it, word by word, with DM Sans's own character widths and
// the pairs it kerns (card-glyphs.ts), never narrower than a browser draws them: the card turns
// off hinting (story-card.tsx), so every browser draws the font's own widths (Codex review of
// #163: Chromium on Linux hinted some text 2 px wider). Not measured with pretext: nothing new is
// installed, and the browser measures the real cards anyway. Text with a character the table
// doesn't have (emoji, other alphabets) is predicted at its most lines.
//
// Sizes here are px at the browser's default 16 px text, and the stylesheet sets them in rem: with
// larger text the cards scale with it, so the same predictions hold (Codex review of #163). The
// column count follows the screen's width only, whatever the text size (Joel, 2026-11-07/08: three
// columns from 1024 px, two from 640 px, one below), so with larger text the list holds fewer of
// these px: the bands reach down to the narrowest list at 200% text (LARGEST_TEXT). A browser
// without container queries keeps one column in normal flow, as on a phone: nothing is predicted,
// so nothing can overlap.
//
// The card's sizes come from card-metrics.ts, which story-card.tsx draws it with.

/** Multi-column layouts and the viewport width each starts at (Tailwind's `sm` and `lg`). */
export const BREAKPOINTS = { 2: 640, 3: 1024 } as const;
export type ColumnCount = keyof typeof BREAKPOINTS;
export const COLUMN_COUNTS = [2, 3] as const satisfies ColumnCount[];
/** The grid's row height in px (`grid-auto-rows`). */
export const ROW_UNIT = 4;
/** The space between cards, both ways, in px. */
export const GAP = 24;
/**
 * The pages around the list (browse, My favourites): 40 px of padding a side from 640 px
 * (`sm:px-10`), content at most 1200 px wide (`max-w-site`). Only the band ranges come from
 * these: the bands themselves follow the list's real width.
 */
const PAGE = { pad: 40, maxWidth: 1200, scrollbar: 20 } as const;
/**
 * The largest text size the bands are made for, as a share of the default 16 px (WCAG 1.4.4's
 * 200%): with larger text still, the list is narrower than the narrowest band and takes its spans.
 */
const LARGEST_TEXT = 2;
/** Each band is this many px of card width wide: a 9:16 video is predicted at most 15 px tall. */
const BAND_STEP = 8;
/** Predictions err tall: a span a little too long leaves a gap; too short would overlap. */
const SLACK = 2;

const rem = (px: number) => `${px / 16}rem`;

/**
 * Each character's place in the table. Format characters (the soft hyphen U+00AD) are left
 * out, so text with one counts at its most lines: they change where a line may break (Codex
 * review of #163, round 2: a soft hyphen wrapped a text one line longer).
 */
const GLYPH_INDEX = new Map(
  [...GLYPH_CHARS]
    .map((ch, i) => [ch, i] as const)
    .filter(([ch]) => !/\p{Cf}/u.test(ch)),
);
/** By weight: each kerned pair (two characters, then its kerning in thousandths of an em). */
const KERNS = Object.fromEntries(
  Object.entries(KERN_EMS).map(([weight, pairs]) => [
    weight,
    new Map(pairs.map((p) => [p.slice(0, 2), Number(p.slice(2))])),
  ]),
);

/**
 * The text's width in px in this style: its characters' widths and its kerned pairs; Infinity
 * if the table lacks one of its characters.
 */
function textWidth(text: string, style: TextStyle): number {
  const { font, weight } = CARD[style];
  let em = 0;
  let last = '';
  for (const ch of text) {
    const i = GLYPH_INDEX.get(ch);
    if (i === undefined) return Infinity;
    em += GLYPH_EMS[weight][i] + (KERNS[weight].get(last + ch) ?? 0);
    last = ch;
  }
  return (em * font) / 1000;
}

/** How much `text` adds after `before` on a line (with the pair they make). */
const widthAfter = (before: string, text: string, style: TextStyle) =>
  textWidth(before + text, style) - textWidth(before, style);

/**
 * How many lines a browser wraps this text into at `width`: word by word at spaces, and a word
 * wider than a line broken anywhere (`overflow-wrap: anywhere` on the card). Infinity (so its
 * most lines) for text with a character the table doesn't have. Only the white space HTML
 * collapses into a space (space, tab, line breaks) separates words; any other (an em space
 * U+2003, a no-break space) is a character the table doesn't have (Codex review of #163, round
 * 2: titles spaced with U+2003 were measured with ordinary spaces).
 */
export function lineCount(
  text: string,
  width: number,
  style: TextStyle,
): number {
  const words = text.split(/[ \t\n\f\r]+/).filter(Boolean);
  if (words.length === 0) return 0;
  let lines = 1;
  let x = 0;
  let last = '';
  for (const word of words) {
    const w = textWidth(word, style);
    if (w === Infinity) return Infinity;
    // After a word on the line: a space, then this word.
    const after = widthAfter(last, ` ${word}`, style);
    if (x > 0 && x + after <= width) {
      x += after;
      last = word.slice(-1);
      continue;
    }
    if (x > 0) lines += 1;
    last = word.slice(-1);
    if (w <= width) {
      x = w;
      continue;
    }
    // A word wider than the line, broken anywhere.
    x = 0;
    let prev = '';
    for (const ch of word) {
      const c = widthAfter(prev, ch, style);
      if (x > 0 && x + c > width) {
        lines += 1;
        x = textWidth(ch, style);
      } else x += c;
      prev = ch;
    }
  }
  return lines;
}

/**
 * What a card's height depends on. `aspect` is width ÷ height of its media; null = none.
 * `player`: its media is Bunny's player (video, audio), never shorter than its controls need.
 */
export interface CardShape {
  aspect: number | null;
  player: boolean;
  title: string;
  excerpt: string;
  themes: string[];
  /** Its top line's label, "Written · 3 min read" or "Video · 0:12" (lib/card-label.ts). */
  label: string;
  /** D72: the card says NEW (a badge in its top line). */
  isNew: boolean;
}

export function cardShape(s: StorySummary): CardShape {
  const audio = audioSize(s.thumbnailWidth, s.thumbnailHeight);
  const aspect =
    s.primaryFormat === 'video'
      ? cardAspect(s.thumbnailWidth, s.thumbnailHeight)
      : s.primaryFormat === 'audio'
        ? cardAspect(audio.width, audio.height) // its thumbnail's shape
        : s.image
          ? cardAspect(s.image.width, s.image.height)
          : null;
  return {
    aspect,
    player: s.primaryFormat !== 'written',
    title: s.title,
    excerpt: s.excerpt,
    themes: s.themes.map((t) => t.name),
    label: cardLabel(s),
    isNew: s.isNew,
  };
}

/** Theme rows: each theme its text plus padding, at most the line, wrapped as flex-wrap does. */
function themeRows(themes: string[], width: number): number {
  const { padX, gap } = CARD.themes;
  let rows = 0;
  let used = Infinity;
  for (const theme of themes) {
    const w = Math.min(width, textWidth(theme, 'themes') + 2 * padX);
    if (used + gap + w > width) {
      rows += 1;
      used = w;
    } else used += gap + w;
  }
  return rows;
}

/** The NEW badge's width (story-card.tsx's NewBadge). */
const BADGE_WIDTH = (() => {
  const b = CARD.badge;
  return textWidth('NEW', 'badge') + 3 * b.tracking * b.font + 2 * b.padX;
})();

/**
 * A text width (px) under which the NEW badge doesn't fit beside the heart at the end of the
 * card's top line: the line then moves below the heart and takes the whole width (CARD_TOP_CSS). A
 * pixel to spare, so a browser's rounding can't leave the badge a fraction too wide.
 */
const BADGE_BESIDE_HEART = CARD.meta.heart + Math.ceil(BADGE_WIDTH) + 1;

/**
 * story-card.tsx's NEW card: its top line in a size container (`.card-top`), moved below the
 * heart when the badge doesn't fit beside it. In rem, as the card.
 */
export const CARD_TOP_CSS = `.card-top{container-type:inline-size}@container (width < ${rem(BADGE_BESIDE_HEART)}){.card-top>p{padding-right:0;margin-top:${rem(CARD.meta.belowHeart)}}}`;

/** Lines of a block of text, at most its line clamp. */
const clamped = (
  text: string,
  width: number,
  style: 'title' | 'excerpt' | 'quote',
) => Math.min(CARD[style].maxLines, lineCount(text, width, style));

/**
 * The card's top line's height in px at this text width, with the space under it. The label, the
 * gap and the name's 2.5rem minimum on one line, beside the heart's room (`pr-10`; every card,
 * Joel 2026-11-09), or below the heart if the badge doesn't fit beside it; otherwise the name
 * drops to a line of its own. A label wider than the line wraps: the badge, then its words.
 */
function metaHeight(shape: CardShape, text: number): number {
  const m = CARD.meta;
  const below = shape.isNew && text < BADGE_BESIDE_HEART;
  const badge = shape.isNew ? BADGE_WIDTH + CARD.badge.after : 0;
  const label = badge + textWidth(shape.label, 'meta');
  const line = text - (below ? 0 : m.heart);
  const lines =
    label + m.gap + m.name <= line
      ? 1
      : label <= line
        ? 2
        : (shape.isNew ? 1 : 0) + lineCount(shape.label, line, 'meta') + 1;
  return (
    lines * m.line +
    (lines - 1) * m.rowGap +
    m.after +
    (below ? m.belowHeart : 0)
  );
}

/**
 * The card's predicted height in px: its media at `cardWidth`, its text wrapped at `textWidth`
 * (a band's widest and narrowest card, so it errs tall). The top line is the one part that can
 * be shorter on a narrower card (below the heart, with the whole width), so where the band holds
 * both, it takes the taller.
 */
export function predictHeight(
  shape: CardShape,
  cardWidth: number,
  textCardWidth = cardWidth,
): number {
  const text = textCardWidth - 2 * CARD.pad;
  const media = !shape.aspect
    ? 0
    : shape.player
      ? Math.max(cardWidth / shape.aspect, CARD.playerMinHeight)
      : cardWidth / shape.aspect;
  const t = CARD.title;
  const title = clamped(shape.title, text, 'title') * t.line + t.after;
  const q = CARD.quote;
  const excerpt =
    shape.aspect === null
      ? clamped(shape.excerpt, text - q.border - q.padL, 'quote') * q.line
      : clamped(shape.excerpt, text, 'excerpt') * CARD.excerpt.line;
  const rows = themeRows(shape.themes, text);
  const themes =
    rows === 0
      ? 0
      : CARD.themes.before +
        rows * CARD.themes.row +
        (rows - 1) * CARD.themes.gap;
  const beside =
    text < BADGE_BESIDE_HEART && BADGE_BESIDE_HEART <= cardWidth - 2 * CARD.pad;
  const meta = Math.max(
    metaHeight(shape, text),
    beside ? metaHeight(shape, BADGE_BESIDE_HEART) : 0,
  );
  return media + 2 * CARD.pad + meta + title + excerpt + themes + SLACK;
}

/** One band of list widths: from `minWidth` px (inclusive) to the next band's. */
export interface Band {
  columns: ColumnCount;
  minWidth: number;
  /** Its narrowest and widest card, in px. */
  narrowest: number;
  widest: number;
}

const cardWidth = (list: number, columns: number) =>
  (list - (columns - 1) * GAP) / columns;

/**
 * The list's width at a column count's breakpoint less the page's padding, at the default text
 * size and without a scrollbar: a tablet at exactly 640 or 1024 px starts a band here.
 */
const listAt = (columns: ColumnCount) => BREAKPOINTS[columns] - 2 * PAGE.pad;
/** Its widest list at the default text size or larger: the next breakpoint's, or the site's. */
const widestList = (columns: ColumnCount) =>
  columns === 2 ? listAt(3) : PAGE.maxWidth;

/**
 * The bands for each column count, from the narrowest list to the widest: from the list at the
 * breakpoint with a scrollbar and the largest text (LARGEST_TEXT; the padding and the screen
 * scale with it), in steps from the list at the breakpoint (listAt), to the widest list. The
 * first band also covers any narrower list, and the last any wider, though the list is never wider
 * than the site (PAGE.maxWidth, `max-w-site`) at the default text size or larger.
 */
export const BANDS: Band[] = COLUMN_COUNTS.flatMap((columns) => {
  const least =
    (BREAKPOINTS[columns] - PAGE.scrollbar) / LARGEST_TEXT - 2 * PAGE.pad;
  const to = widestList(columns);
  const step = BAND_STEP * columns;
  let first = listAt(columns);
  while (first > least) first -= step;
  const bands: Band[] = [];
  for (let min = first; min < to; min += step)
    bands.push({
      columns,
      minWidth: min,
      narrowest: cardWidth(min, columns),
      widest: cardWidth(Math.min(min + step, to), columns),
    });
  return bands;
});

/** Each height into the shortest column (ties: leftmost), continuing from `start`. */
export function place(
  heights: number[],
  columns: number,
  start?: number[],
): { column: number[]; heights: number[] } {
  const cols = start?.length === columns ? [...start] : Array(columns).fill(0);
  const column = heights.map((height) => {
    let best = 0;
    for (let i = 1; i < columns; i++) if (cols[i] < cols[best]) best = i;
    cols[best] += height + GAP;
    return best;
  });
  return { column, heights: cols };
}

/** Grid rows for a card of this height, including the gap under it. */
export const spanFor = (heightPx: number) =>
  Math.ceil((heightPx + GAP) / ROW_UNIT);

export interface CardLayout {
  /** Its column (0-based) at each column count. */
  col: Record<ColumnCount, number>;
  /** Its row span in each band (BANDS' order). */
  span: number[];
}
export type ColumnHeights = Record<ColumnCount, number[]>;

/**
 * Columns and spans for these cards, continuing from `start`. Columns are chosen from the
 * predictions in the band in the middle of each column count's widths at the default text size:
 * they balance the columns, and a card keeps its column at any width within that column count.
 */
export function layoutFor(
  cards: StorySummary[],
  start?: Partial<ColumnHeights>,
): { cards: CardLayout[]; heights: ColumnHeights } {
  const shapes = cards.map(cardShape);
  const spans = BANDS.map((band) =>
    shapes.map((s) => spanFor(predictHeight(s, band.widest, band.narrowest))),
  );
  const out: CardLayout[] = cards.map((_, i) => ({
    col: { 2: 0, 3: 0 },
    span: spans.map((band) => band[i]),
  }));
  const heights = {} as ColumnHeights;
  for (const n of COLUMN_COUNTS) {
    const mid = (listAt(n) + widestList(n)) / 2;
    const middle =
      spans[BANDS.findLastIndex((b) => b.columns === n && b.minWidth <= mid)];
    const placed = place(
      middle.map((span) => span * ROW_UNIT - GAP),
      n,
      start?.[n],
    );
    heights[n] = placed.heights;
    placed.column.forEach((c, i) => {
      out[i].col[n] = c;
    });
  }
  return { cards: out, heights };
}

/** A card's custom properties: its column per column count (`--c2`) and span per band (`--s0`). */
export function layoutStyle(layout: CardLayout): Record<string, number> {
  const style: Record<string, number> = {};
  for (const n of COLUMN_COUNTS) style[`--c${n}`] = layout.col[n] + 1;
  layout.span.forEach((span, i) => {
    style[`--s${i}`] = span;
  });
  return style;
}

/**
 * The masonry's stylesheet (story-masonry.tsx renders it once per page), in rem so it scales with
 * the reader's text size. One column in normal flow, as on a phone, until the viewport reaches a
 * breakpoint, in px so the column count follows the screen's width whatever the text size (Joel,
 * 2026-11-07/08). Then, in the list (`.masonry-box`, a size container), columns with 4 px rows:
 * each card in its column (`--c2`, `--c3`), spanning its measured rows (`--m`,
 * story-masonry.tsx) or, before that, its predicted span in the band the list's width is in
 * (`--s0`…; the first band from 0). `dense` stacks each column's cards with no gaps. A browser
 * without container queries, or a list that isn't a size container (no JavaScript), keeps one
 * column.
 *
 * In columns, each list item fills its rows and clips below them (`overflow-y: clip`), so a card
 * guessed short can't draw over the next one; the card keeps its own height (`height: auto`,
 * which the page measures). Sideways nothing is clipped, and the item starts 0.25rem above its
 * rows (padding, so the card doesn't move) to leave room for the card's focus ring above it;
 * below the card, its span's gap holds the ring.
 */
export const MASONRY_CSS = [
  `.masonry-box{container-type:inline-size}`,
  `.masonry{display:grid;grid-template-columns:minmax(0,1fr);gap:${rem(GAP)};max-width:30rem;margin-inline:auto}`,
  ...COLUMN_COUNTS.map((n) => {
    const rules = BANDS.flatMap((band, i) => {
      if (band.columns !== n) return [];
      const first = BANDS.findIndex((b) => b.columns === n) === i;
      const grid = first
        ? n === 2
          ? `.masonry{max-width:none;grid-template-columns:repeat(2,minmax(0,1fr));grid-auto-rows:${rem(ROW_UNIT)};grid-auto-flow:row dense;gap:0 ${rem(GAP)}}.masonry>li{overflow-x:visible;overflow-y:clip;margin-top:-.25rem;padding-top:.25rem}.masonry>li>*{height:auto}`
          : `.masonry{grid-template-columns:repeat(${n},minmax(0,1fr))}`
        : '';
      const column = first ? `grid-column:var(--c${n});` : '';
      return [
        `@container (min-width:${first ? 0 : rem(band.minWidth)}){${grid}.masonry>li{${column}grid-row-end:span var(--m,var(--s${i}))}}`,
      ];
    });
    return `@media (min-width:${BREAKPOINTS[n]}px){${rules.join('')}}`;
  }),
].join('\n');
