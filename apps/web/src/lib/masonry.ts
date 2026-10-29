import type { StorySummary } from './browse';
import { audioSize, cardAspect } from './shape';

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
  /**
   * That line's parts (D72 badge, label, the name's 2.5rem minimum, the heart's room on a card
   * without a picture): the name drops to a second line (`gap-y-1` + 20) when they don't fit.
   */
  metaLine: {
    font: 13,
    glyph: 0.48,
    badge: 44 + 8,
    gap: 12,
    name: 40,
    heart: 40,
    second: 4 + 20,
  },
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
  /** Its top line's label, "Written · 3 min read" or "Video · 0:12" (story-card.tsx). */
  labelChars: number;
  /** D72: the card says NEW (a badge in its top line). */
  isNew: boolean;
}

/** story-card.tsx's `cardLabel`, counted: about 1,000 characters a minute for written stories. */
function labelChars(s: StorySummary): number {
  if (s.primaryFormat === 'written')
    return `Written · ${Math.max(1, Math.ceil(s.textLength / 1000))} min read`
      .length;
  const d = s.durationSeconds;
  return d ? `Video · ${Math.floor(d / 60)}:00`.length : 'Video'.length;
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
    kind: s.primaryFormat,
    aspect,
    titleChars: [...s.title].length,
    excerptChars: [...s.excerpt].length,
    tagChars: s.tags.map((t) => [...t.name].length),
    labelChars: labelChars(s),
    isNew: s.isNew,
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

/**
 * The card's predicted height in px: its media at `cardWidth`, its text wrapped at `textWidth`
 * (the server passes the widest and narrowest card of a column count, so it errs tall).
 */
export function predictHeight(
  shape: CardShape,
  cardWidth: number,
  textWidth = cardWidth,
): number {
  const text = textWidth - 2 * CARD.padX;
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
  const m = CARD.metaLine;
  const metaWidth =
    (shape.isNew ? m.badge : 0) +
    shape.labelChars * m.font * m.glyph +
    m.gap +
    m.name +
    (shape.aspect === null ? m.heart : 0);
  const meta = CARD.meta + (metaWidth > text ? m.second : 0);
  return media + CARD.padY + meta + title + excerpt + tags + CARD.slack;
}

/**
 * The narrowest and widest card per column count, for the server's prediction: it can't know
 * the screen, and a span too short overlaps the next card on first paint (and for good without
 * JavaScript), so media is predicted at the widest card and text at the narrowest. Mirrors the
 * grid in global.css and the page's padding (16 px a side below 640 px, 40 px from 640 px):
 * 1 column from 320 px, at most 480 px wide; 2 columns from 640 to 1023 px; 3 from 1024 px up
 * to the 1200 px site width. (Codex review of #72, round 3: one width of about 337 px for
 * 3 columns made 9:16 videos 35 px short at 1280 px, where cards are 357 px.)
 */
export function columnWidths(columns: number): {
  narrowest: number;
  widest: number;
} {
  const card = (viewport: number, pad: number) =>
    (viewport - 2 * pad - (columns - 1) * GAP) / columns;
  if (columns <= 1) return { narrowest: card(320, 16), widest: 480 };
  if (columns === 2)
    return { narrowest: card(640, 40), widest: card(1023, 40) };
  return { narrowest: card(1024, 40), widest: card(1200, 40) };
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
    const { narrowest, widest } = columnWidths(n);
    const predicted = shapes.map((s) => predictHeight(s, widest, narrowest));
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
