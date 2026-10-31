import type { StorySummary } from './browse';
import { cardLabel } from './card-label';
import { GLYPH_CHARS, GLYPH_WIDTHS } from './card-glyphs';
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
// by a few pixels and never short: too short would overlap the next card on first paint, and
// for good without JavaScript. Before the bands, one guess covered 640 to 1023 px and cards
// jumped up by 100 px or more once measured (Joel, 2026-10-31, option B: guess better).
//
// Text is wrapped as the browser wraps it, word by word, with DM Sans's own character widths
// (card-glyphs.ts, measured from the font the site serves), not measured with pretext: nothing
// new is installed, and the browser measures the real cards anyway.
//
// The numbers below mirror story-card.tsx; change them together.

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
/** Each band is this many px of card width wide: a 9:16 video is predicted at most 15 px tall. */
const BAND_STEP = 8;

const CARD = {
  padX: 20,
  padY: 40, // 20 top + 20 bottom
  meta: {
    line: 20,
    after: 8,
    font: 13,
    gap: 12,
    name: 40,
    heart: 40,
    second: 4 + 20,
  },
  /** D72's NEW badge before the label: 11 px semibold, tracking-wide, px-1.5, then gap-x-2. */
  badge: { font: 11, tracking: 0.025, padX: 12, after: 8 },
  title: { font: 17, weight: 600, line: 24, maxLines: 3, after: 6 },
  excerpt: { font: 15, weight: 400, line: 24, maxLines: 3, inset: 0 },
  /** A written story without a picture: its excerpt as a quote, inside a border and padding. */
  quote: { font: 18, weight: 400, line: 28, maxLines: 6, inset: 2 + 12 },
  tags: { before: 14, row: 24, gap: 6, font: 12, padX: 20 },
  /** Predictions err tall: a span a little too long leaves a gap; too short would overlap. */
  slack: 2,
} as const;

type Weight = keyof typeof GLYPH_WIDTHS;
const GLYPH_INDEX = new Map([...GLYPH_CHARS].map((ch, i) => [ch, i]));
/** For a character the table doesn't have: the widest one it does. */
const WIDEST = {
  400: Math.max(...GLYPH_WIDTHS[400]),
  600: Math.max(...GLYPH_WIDTHS[600]),
};

/**
 * The text's width in px: the sum of its characters' widths, or of those rounded to whole pixels
 * where that's wider (Chromium on Linux draws whole-pixel widths; others don't round), so it is
 * never narrower than any browser draws it. Kerning only narrows text.
 */
function textWidth(text: string, font: number, weight: Weight = 400): number {
  let exact = 0;
  let whole = 0;
  for (const ch of text) {
    const i = GLYPH_INDEX.get(ch);
    const em = i === undefined ? WIDEST[weight] : GLYPH_WIDTHS[weight][i];
    exact += (em * font) / 1000;
    whole += Math.round((em * font) / 1000);
  }
  return Math.max(exact, whole);
}

/**
 * How many lines the browser wraps this text into at `width`: word by word at spaces, and a word
 * wider than a line broken anywhere (`overflow-wrap: anywhere` on the card).
 */
export function lineCount(
  text: string,
  width: number,
  font: number,
  weight: Weight = 400,
): number {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  const space = textWidth(' ', font, weight);
  let lines = 1;
  let x = 0;
  for (const word of words) {
    const w = textWidth(word, font, weight);
    if (x > 0 && x + space + w <= width) {
      x += space + w;
      continue;
    }
    if (x > 0) lines += 1;
    if (w <= width) {
      x = w;
      continue;
    }
    x = 0;
    for (const ch of word) {
      const c = textWidth(ch, font, weight);
      if (x > 0 && x + c > width) {
        lines += 1;
        x = 0;
      }
      x += c;
    }
  }
  return lines;
}

/** What a card's height depends on. `aspect` is width ÷ height of its media; null = none. */
export interface CardShape {
  aspect: number | null;
  title: string;
  excerpt: string;
  tags: string[];
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
    title: s.title,
    excerpt: s.excerpt,
    tags: s.tags.map((t) => t.name),
    label: cardLabel(s),
    isNew: s.isNew,
  };
}

/** Tag rows: each tag its text plus padding, at most the line, wrapped as flex-wrap does. */
function tagRows(tags: string[], width: number): number {
  const { font, padX, gap } = CARD.tags;
  let rows = 0;
  let used = Infinity;
  for (const tag of tags) {
    const w = Math.min(width, textWidth(tag, font) + padX);
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
  return textWidth('NEW', b.font, 600) + 3 * b.tracking * b.font + b.padX;
})();

/**
 * The card's predicted height in px: its media at `cardWidth`, its text wrapped at `textWidth`
 * (a band's widest and narrowest card, so it errs tall).
 */
export function predictHeight(
  shape: CardShape,
  cardWidth: number,
  textCardWidth = cardWidth,
): number {
  const text = textCardWidth - 2 * CARD.padX;
  const media = shape.aspect ? cardWidth / shape.aspect : 0;
  const t = CARD.title;
  const title =
    Math.min(t.maxLines, lineCount(shape.title, text, t.font, t.weight)) *
      t.line +
    t.after;
  const e = shape.aspect === null ? CARD.quote : CARD.excerpt;
  const excerpt =
    Math.min(
      e.maxLines,
      lineCount(shape.excerpt, text - e.inset, e.font, e.weight),
    ) * e.line;
  const rows = tagRows(shape.tags, text);
  const tags =
    rows === 0
      ? 0
      : CARD.tags.before + rows * CARD.tags.row + (rows - 1) * CARD.tags.gap;
  // The label, the gap and the name's 2.5rem minimum on one line, beside the heart's room on a
  // card without a picture (`pr-10`); otherwise the name drops to a second line.
  const m = CARD.meta;
  const label =
    (shape.isNew ? BADGE_WIDTH + CARD.badge.after : 0) +
    textWidth(shape.label, m.font);
  const line = text - (shape.aspect === null ? m.heart : 0);
  const meta =
    m.line + m.after + (label + m.gap + m.name > line ? m.second : 0);
  return media + CARD.padY + meta + title + excerpt + tags + CARD.slack;
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
 * The bands for each column count, from the narrowest list to the widest: the viewport at the
 * breakpoint less the page's padding (a tablet at exactly 640 or 1024 px starts a band), or up to
 * a scrollbar narrower, to the next breakpoint's list or the site's width. The first band of
 * each column count also covers anything narrower; the last anything wider, though the site is
 * never wider than PAGE.maxWidth (`max-w-site`).
 */
export const BANDS: Band[] = COLUMN_COUNTS.flatMap((columns) => {
  const from = BREAKPOINTS[columns] - 2 * PAGE.pad;
  const to = columns === 2 ? BREAKPOINTS[3] - 2 * PAGE.pad : PAGE.maxWidth;
  const step = BAND_STEP * columns;
  const band = (min: number, max: number): Band => ({
    columns,
    minWidth: min,
    narrowest: cardWidth(min, columns),
    widest: cardWidth(max, columns),
  });
  const bands = [band(from - PAGE.scrollbar, from)];
  for (let min = from; min < to; min += step)
    bands.push(band(min, Math.min(min + step, to)));
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
 * predictions in the middle band of each column count: they balance the columns, and a card
 * keeps its column at any width within that column count.
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
    const own = BANDS.flatMap((band, i) => (band.columns === n ? [i] : []));
    const middle = spans[own[Math.floor(own.length / 2)]];
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

const media = (columns: ColumnCount) =>
  columns === 2
    ? `(min-width: ${BREAKPOINTS[2]}px) and (max-width: ${BREAKPOINTS[3] - 0.02}px)`
    : `(min-width: ${BREAKPOINTS[3]}px)`;

/**
 * The masonry's stylesheet (story-masonry.tsx renders it once per page). One column below 640 px,
 * in normal flow. From 640 px, columns with 4 px rows: each card in its column (`--c2`, `--c3`),
 * spanning its measured rows (`--m`, story-masonry.tsx) or, before that, its band's predicted
 * span. The list is a size container, so each band follows the list's own width. `dense` stacks
 * each column's cards with no gaps.
 */
export const MASONRY_CSS = [
  `.masonry{display:grid;grid-template-columns:minmax(0,1fr);gap:${GAP}px;max-width:30rem;margin-inline:auto;container-type:inline-size}`,
  `@media (min-width:${BREAKPOINTS[2]}px){.masonry{max-width:none;grid-template-columns:repeat(2,minmax(0,1fr));grid-auto-rows:${ROW_UNIT}px;grid-auto-flow:row dense;gap:0 ${GAP}px;align-items:start}.masonry>li{grid-column:var(--c2)}}`,
  `@media (min-width:${BREAKPOINTS[3]}px){.masonry{grid-template-columns:repeat(3,minmax(0,1fr))}.masonry>li{grid-column:var(--c3)}}`,
  ...COLUMN_COUNTS.map((n) => {
    const rules = BANDS.flatMap((band, i) => {
      if (band.columns !== n) return [];
      const rule = `.masonry>li{grid-row-end:span var(--m,var(--s${i}))}`;
      const first = BANDS.findIndex((b) => b.columns === n) === i;
      return first
        ? [rule]
        : [`@container (min-width:${band.minWidth}px){${rule}}`];
    });
    return `@media ${media(n)}{${rules.join('')}}`;
  }),
].join('\n');
