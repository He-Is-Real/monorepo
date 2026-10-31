import type { MediaUrls } from './media-urls';
import type { ThemeRef } from './themes';

/** A published clip's stored fields (`publicStory.media[*]`). Never sent as they are. */
export interface StoredMedia {
  format: 'video' | 'audio';
  bunnyVideoId?: string;
  thumbnailPath?: string;
  width?: number;
  height?: number;
}

/**
 * A story's stored image (`publicStory.image`): a written story's image, an audio story's picture
 * or a video's own thumbnail (M2 plan PR 10). Never sent as it is.
 */
export interface StoredImage {
  path: string;
  width: number;
  height: number;
  alt?: string;
}

/**
 * `components.yaml#/components/schemas/StorySummary`: a card. What D55's balanced masonry
 * predicts heights from: the picture's size (clip or image), and a bounded excerpt to measure.
 * No metrics, nothing about the submitter, no playback or storage data.
 */
export interface StorySummary {
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  bylineName: string | null;
  primaryFormat: 'video' | 'audio' | 'written';
  durationSeconds: number | null;
  thumbnailUrl: string | null;
  thumbnailWidth: number | null;
  thumbnailHeight: number | null;
  image: {
    url: string | null;
    width: number;
    height: number;
    alt: string | null;
  } | null;
  textLength: number;
  themes: ThemeRef[];
  publishedAt: string;
}

/** About how many characters a card's excerpt shows. */
export const EXCERPT_CHARS = 240;
/** How far back from the limit a word break may be; further than this, cut at a character. */
const WORD_SLACK = 40;
/** How much of the description and the text the query fetches (more than an excerpt needs). */
export const FETCH_CHARS = EXCERPT_CHARS + 60;

/**
 * The card fields of `publicStory`, for `SELECT … FROM publicStory`. Only the start of the
 * description and text: a description can be 5,000 characters and a text 10,000 (A3).
 */
export const SUMMARY_FIELDS = `
  record::id(id) AS id, slug, title, bylineName, primaryFormat, media, image, durationSeconds,
  string::slice(description, 0, ${FETCH_CHARS}) AS description,
  string::slice(body ?? '', 0, ${FETCH_CHARS}) AS bodyStart,
  string::len(body ?? '') AS textLength,
  publishedAt, <string> publishedAt AS cursorAt,
  (SELECT record::id(id) AS id, name FROM theme
    WHERE id IN $parent.themeRefs ORDER BY name) AS themes`;

/** A row selected with SUMMARY_FIELDS. */
export interface SummaryRow {
  id: string;
  slug: string;
  title: string;
  description: string;
  bodyStart: string;
  textLength: number;
  bylineName?: string;
  primaryFormat: StorySummary['primaryFormat'];
  media?: StoredMedia[];
  image?: StoredImage;
  durationSeconds?: number;
  themes?: ThemeRef[];
  publishedAt: string;
  /** publishedAt as SurrealDB writes it (nanoseconds), for cursors. */
  cursorAt: string;
}

/**
 * The picture shown for a video or audio story (M2 plan PR 10; Joel, 2026-10-30): the person's
 * own image when the story has one, in place of Bunny's thumbnail; otherwise Bunny's, at the
 * clip's recorded size (a video's, or an audio file's thumbnail's: Joel, 2026-10-24). The one
 * rule for cards and the story page, so every view shows the same picture.
 */
export function clipPicture(
  clip: StoredMedia | undefined,
  image: StoredImage | undefined,
  urls: MediaUrls,
): { url: string | null; width: number | null; height: number | null } {
  if (!clip) return { url: null, width: null, height: null };
  if (image) {
    return {
      url: urls.imageUrl(image.path),
      width: image.width,
      height: image.height,
    };
  }
  return {
    url: urls.thumbnailUrl(clip.bunnyVideoId, clip.thumbnailPath),
    width: clip.width ?? null,
    height: clip.height ?? null,
  };
}

/** A card; thumbnail and image links are signed by the same `MediaUrls` as the story page (D52). */
export function toSummary(row: SummaryRow, urls: MediaUrls): StorySummary {
  const picture = clipPicture(row.media?.[0], row.image, urls);
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    excerpt: excerpt(row.description.trim() ? row.description : row.bodyStart),
    bylineName: row.bylineName ?? null,
    primaryFormat: row.primaryFormat,
    durationSeconds: row.durationSeconds ?? null,
    thumbnailUrl: picture.url,
    thumbnailWidth: picture.width,
    thumbnailHeight: picture.height,
    image: row.image
      ? {
          url: urls.imageUrl(row.image.path),
          width: row.image.width,
          height: row.image.height,
          alt: row.image.alt ?? null,
        }
      : null,
    textLength: row.textLength,
    themes: row.themes ?? [],
    publishedAt: row.publishedAt,
  };
}

/**
 * The start of a text on one line: at most `max` characters (code points, so emoji stay whole),
 * cut at a word when one ends near the limit (dropping a trailing comma, semicolon or colon),
 * then `…`.
 */
export function excerpt(text: string, max = EXCERPT_CHARS): string {
  const chars = [...text.replace(/\s+/g, ' ').trim()];
  if (chars.length <= max) return chars.join('');
  let end = max;
  for (let i = max; i >= max - WORD_SLACK; i--) {
    if (chars[i] === ' ') {
      end = i;
      break;
    }
  }
  return `${chars
    .slice(0, end)
    .join('')
    .replace(/[\s,;:]+$/, '')}…`;
}
