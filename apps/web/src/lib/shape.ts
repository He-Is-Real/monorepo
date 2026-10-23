// D53: pictures and videos keep their real shape (width × height), but cards show them clamped
// between 9:16 (tall) and 2:1 (wide), so extreme shapes can't break the masonry (D55). Taller or
// wider items are letterboxed (video) or cropped around the centre (images). Uploads beyond 1:3
// or 3:1 are refused by the database, so nothing stored is more extreme than that.

/** A card's width ÷ height limits. */
export const CARD_ASPECT = { min: 9 / 16, max: 2 } as const;

/** The card's width ÷ height for an item of this size; square when the size is unknown. */
export function cardAspect(
  width: number | null | undefined,
  height: number | null | undefined,
): number {
  if (!width || !height || !(width > 0) || !(height > 0)) return 1;
  return Math.min(CARD_ASPECT.max, Math.max(CARD_ASPECT.min, width / height));
}

/** Shown when the person gave no description of their image (D53). */
export const DEFAULT_IMAGE_ALT = 'A photo shared with this story';

export function imageAlt(image: { alt: string | null }): string {
  return image.alt?.trim() || DEFAULT_IMAGE_ALT;
}
