// A story card's sizes, in px at the browser's default 16 px text size: story-card.tsx draws the
// card with them (as rem, through CARD_CSS's custom properties, so they grow with a reader's text
// size) and lib/masonry.ts predicts its height from them (D55). One place, so the two can't drift.
// tools/scripts/card-glyph-widths.mjs measures the fonts below for lib/card-glyphs.ts.

export const CARD = {
  pad: 20,
  /**
   * A video or audio card's player box is never shorter than this (story-media.tsx's
   * PLAYER_MIN_HEIGHT: room for Bunny's controls). In rem like the rest of the card, so it grows
   * with the reader's text size: the masonry's spans are in rem, and a minimum in px was predicted
   * at twice its height with 200% text, so cards moved up once measured (Codex review of #207).
   * Never under these px, though, with text set smaller than the default: the controls need them.
   */
  playerMinHeight: 184,
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
    /** The heart sits at the top line's end (every card); the line keeps this much room for it. */
    heart: 40,
    /**
     * A card too narrow for the NEW badge beside the heart: its top line moves down this far,
     * below the heart (heart-button.tsx: 0.5rem from the card's edge, `size-11`, less the pad).
     */
    belowHeart: 32,
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
  themes: { font: 12, weight: 400, before: 14, row: 24, gap: 6, padX: 10 },
} as const;

/** The card's text styles, each measured on its own (lib/card-glyphs.ts). */
export type TextStyle =
  'meta' | 'badge' | 'title' | 'excerpt' | 'quote' | 'themes';

const rem = (px: number) => `${px / 16}rem`;

/**
 * CARD as custom properties on each card and NEW badge (story-card.tsx renders it once per page).
 */
export const CARD_CSS = `.story-card,[data-new-badge]{${Object.entries({
  pad: rem(CARD.pad),
  'player-min': `max(${CARD.playerMinHeight}px,${rem(CARD.playerMinHeight)})`,
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
  'themes-font': rem(CARD.themes.font),
  'themes-before': rem(CARD.themes.before),
  'themes-row': rem(CARD.themes.row),
  'themes-gap': rem(CARD.themes.gap),
  'themes-pad': rem(CARD.themes.padX),
})
  .map(([name, value]) => `--card-${name}:${value}`)
  .join(';')}}`;
