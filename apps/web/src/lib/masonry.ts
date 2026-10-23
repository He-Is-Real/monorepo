import type { StorySummary } from './browse';
import { cardAspect } from './shape';

// D55: balanced masonry from predicted heights. A card's height is its fixed parts plus its
// media (card width ÷ the clamped shape, D53) plus its text lines. Each card goes into the
// currently shortest column; the DOM stays in date order and CSS grid places the cards
// (`grid-auto-flow: dense`, a column and a row span per card). The server lays out every column
// count and the stylesheet picks one per breakpoint, so the first paint is already balanced. In
// the browser, measured heights replace the predicted spans (browse-results.tsx); cards never
// change column.
//
// Text is estimated from character counts (average glyph widths for DM Sans), not measured with
// pretext: the browser measures the real cards anyway, so an estimate is enough to choose
// columns, and nothing new is installed.
//
// The numbers below mirror story-card.tsx; change them together.

export const COLUMN_COUNTS = [1, 2, 3] as const;
export type ColumnCount = (typeof COLUMN_COUNTS)[number];
/** The grid's row height in px (`grid-auto-rows`). */
export const ROW_UNIT = 4;
/** The space between cards, both ways, in px. */
export const GAP = 24;

const CARD = {
  padX: 20,
  padY: 40, // 20 top + 20 bottom
  meta: 20 + 8, // the "Video · 0:12" line and the space under it
  title: { font: 17, line: 24, maxLines: 3, glyph: 0.56, after: 6 },
  excerpt: { font: 15, line: 24, maxLines: 3, glyph: 0.5 },
  quote: { font: 18, line: 28, maxLines: 6, glyph: 0.5 }, // written, no image
  tags: { before: 14, row: 24, gap: 6, font: 12, glyph: 0.55, padX: 20 },
  /** Predictions err tall: a span a little too long leaves a gap; too short would overlap. */
  slack: 4,
} as const;

/** What a card's height depends on. `aspect` is width ÷ height of its media; null = none. */
export interface CardShape {
  kind: 'video' | 'audio' | 'written';
  aspect: number | null;
  titleChars: number;
  excerptChars: number;
  tagChars: number[];
}

export function cardShape(s: StorySummary): CardShape {
  const aspect =
    s.primaryFormat === 'video'
      ? cardAspect(s.thumbnailWidth, s.thumbnailHeight)
      : s.primaryFormat === 'audio'
        ? 2 // the audio band
        : s.image
          ? cardAspect(s.image.width, s.image.height)
          : null;
  return {
    kind: s.primaryFormat,
    aspect,
    titleChars: [...s.title].length,
    excerptChars: [...s.excerpt].length,
    tagChars: s.tags.map((t) => [...t.name].length),
  };
}

const lines = (chars: number, font: number, glyph: number, width: number) =>
  chars === 0 ? 0 : Math.max(1, Math.ceil((chars * font * glyph) / width));

function tagRows(tagChars: number[], width: number): number {
  const { font, glyph, padX, gap } = CARD.tags;
  let rows = 0;
  let used = Infinity;
  for (const chars of tagChars) {
    const w = Math.min(width, chars * font * glyph + padX);
    if (used + gap + w > width) {
      rows += 1;
      used = w;
    } else used += gap + w;
  }
  return rows;
}

/** The card's predicted height in px at `cardWidth`. */
export function predictHeight(shape: CardShape, cardWidth: number): number {
  const text = cardWidth - 2 * CARD.padX;
  const media = shape.aspect ? cardWidth / shape.aspect : 0;
  const t = CARD.title;
  const title =
    Math.min(t.maxLines, lines(shape.titleChars, t.font, t.glyph, text)) *
      t.line +
    t.after;
  const e = shape.aspect === null ? CARD.quote : CARD.excerpt;
  const excerpt =
    Math.min(e.maxLines, lines(shape.excerptChars, e.font, e.glyph, text)) *
    e.line;
  const rows = tagRows(shape.tagChars, text);
  const tags =
    rows === 0
      ? 0
      : CARD.tags.before + rows * CARD.tags.row + (rows - 1) * CARD.tags.gap;
  return media + CARD.padY + CARD.meta + title + excerpt + tags + CARD.slack;
}

/**
 * A representative card width per column count, for the server's prediction (it can't know the
 * screen). Mirrors the grid in global.css: 1 column up to 480 px wide; 2 columns from 640 px
 * (container ≈ 750 px); 3 from 1024 px (container ≈ 1060 px of the 1200 px site width).
 */
export function columnWidth(columns: number): number {
  if (columns <= 1) return 440;
  if (columns === 2) return (750 - GAP) / 2;
  return (1060 - 2 * GAP) / 3;
}

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
  col: Record<ColumnCount, number>;
  span: Record<ColumnCount, number>;
}
export type ColumnHeights = Record<ColumnCount, number[]>;

/** Columns and spans for these cards at every column count, continuing from `start`. */
export function layoutFor(
  cards: StorySummary[],
  start?: Partial<ColumnHeights>,
): { cards: CardLayout[]; heights: ColumnHeights } {
  const shapes = cards.map(cardShape);
  const out: CardLayout[] = cards.map(
    () => ({ col: {}, span: {} }) as CardLayout,
  );
  const heights = {} as ColumnHeights;
  for (const n of COLUMN_COUNTS) {
    const predicted = shapes.map((s) => predictHeight(s, columnWidth(n)));
    const placed = place(
      predicted.map((p) => spanFor(p) * ROW_UNIT - GAP),
      n,
      start?.[n],
    );
    heights[n] = placed.heights;
    predicted.forEach((p, i) => {
      out[i].col[n] = placed.column[i];
      out[i].span[n] = spanFor(p);
    });
  }
  return { cards: out, heights };
}
