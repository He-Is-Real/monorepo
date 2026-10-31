// A story card's sizes, in px at the browser's default 16 px text size: story-card.tsx draws the
// card with them (as rem, through CARD_CSS's custom properties, so they grow with a reader's text
// size) and lib/masonry.ts predicts its height from them (D55). One place, so the two can't drift.
// tools/scripts/card-glyph-widths.mjs measures the fonts below for lib/card-glyphs.ts.

export const CARD = {
  pad: 20,
  /** Its top line: the label ("Written · 3 min read") and the person's name. */
  meta: {
    font: 13,
    weight: 400,
    line: 20,
    after: 8,
    /** Between the label and the name, and between the lines when they wrap. */
    gap: 12,
    rowGap: 4,
    /** The name keeps at least this much room, or moves to its own line. */
    name: 40,
    /** On a card without a picture the heart sits in the top line's corner. */
    heart: 40,
  },
  /** D72's NEW badge before the label: semibold, tracked, in a pill. */
  badge: {
    font: 11,
    weight: 600,
    line: 20,
    tracking: 0.025,
    padX: 6,
    after: 8,
  },
  title: { font: 17, weight: 600, line: 24, maxLines: 3, after: 6 },
  excerpt: { font: 15, weight: 400, line: 24, maxLines: 3 },
  /** A written story without a picture: its excerpt as a quote, inside a border and padding. */
  quote: { font: 18, weight: 400, line: 28, maxLines: 6, border: 2, padL: 12 },
  tags: { font: 12, weight: 400, before: 14, row: 24, gap: 6, padX: 10 },
} as const;

/** The card's text styles, each measured on its own (lib/card-glyphs.ts). */
export type TextStyle =
  'meta' | 'badge' | 'title' | 'excerpt' | 'quote' | 'tags';

const rem = (px: number) => `${px / 16}rem`;

/**
 * CARD as custom properties on each card and NEW badge (story-card.tsx renders it once per page).
 */
export const CARD_CSS = `.story-card,[data-new-badge]{${Object.entries({
  pad: rem(CARD.pad),
  'meta-font': rem(CARD.meta.font),
  'meta-line': rem(CARD.meta.line),
  'meta-after': rem(CARD.meta.after),
  'meta-gap': rem(CARD.meta.gap),
  'meta-row-gap': rem(CARD.meta.rowGap),
  'meta-name': rem(CARD.meta.name),
  'meta-heart': rem(CARD.meta.heart),
  'badge-font': rem(CARD.badge.font),
  'badge-line': rem(CARD.badge.line),
  'badge-tracking': `${CARD.badge.tracking}em`,
  'badge-pad': rem(CARD.badge.padX),
  'badge-after': rem(CARD.badge.after),
  'title-font': rem(CARD.title.font),
  'title-line': rem(CARD.title.line),
  'title-lines': CARD.title.maxLines,
  'title-after': rem(CARD.title.after),
  'excerpt-font': rem(CARD.excerpt.font),
  'excerpt-line': rem(CARD.excerpt.line),
  'excerpt-lines': CARD.excerpt.maxLines,
  'quote-font': rem(CARD.quote.font),
  'quote-line': rem(CARD.quote.line),
  'quote-lines': CARD.quote.maxLines,
  'quote-border': `${CARD.quote.border}px`,
  'quote-pad': rem(CARD.quote.padL),
  'tags-font': rem(CARD.tags.font),
  'tags-before': rem(CARD.tags.before),
  'tags-row': rem(CARD.tags.row),
  'tags-gap': rem(CARD.tags.gap),
  'tags-pad': rem(CARD.tags.padX),
})
  .map(([name, value]) => `--card-${name}:${value}`)
  .join(';')}}`;
