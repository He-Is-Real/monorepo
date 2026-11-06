import type { MediaUrls } from './media-urls';
import type { ThemeRef } from './themes';

/**
 * A published clip's stored fields (R12: the storyFile row `story.mediaFile` points at; its id is
 * the Bunny video id). Never sent as they are.
 */
export interface StoredMedia {
  format: 'video' | 'audio';
  bunnyVideoId?: string;
  thumbnailPath?: string;
  width?: number;
  height?: number;
}

/**
 * A story's stored image: a written story's image, an audio story's picture or a video's own
 * thumbnail (M2 plan PR 10). R12: the storyFile row `story.image.file` points at (its id is the
 * path; its size), with the story's own `image.alt`. Never sent as it is.
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
 * A story's published files as StoredMedia[] (`media`), the clip's length (`durationSeconds`) and
 * StoredImage (`image`), for `SELECT … FROM story`. R12: read through the story's pointers to its
 * storyFile rows; only the fields a reader uses, never `processing`, which the public can't read
 * anyway.
 */
export const FILE_FIELDS = `
  IF mediaFile != NONE {
    [object::extend(mediaFile.{ format, thumbnailPath, width, height },
      { bunnyVideoId: record::id(mediaFile) })]
  } ELSE { [] } AS media,
  mediaFile.lengthSeconds AS durationSeconds,
  IF image != NONE {
    object::extend(image.file.{ width, height }, { path: record::id(image.file), alt: image.alt })
  } AS image`;

/**
 * The card fields of a published story, for `SELECT … FROM story` (R11: one story table; its
 * publish date is on its current approved status entry). Only the start of the description and
 * text: a description can be 5,000 characters and a text 10,000 (A3). Only the file fields a
 * card uses (FILE_FIELDS).
 */
export const SUMMARY_FIELDS = `
  record::id(id) AS id, slug, title, bylineName, primaryFormat,
  ${FILE_FIELDS},
  string::slice(description, 0, ${FETCH_CHARS}) AS description,
  string::slice(body ?? '', 0, ${FETCH_CHARS}) AS bodyStart,
  string::len(body ?? '') AS textLength,
  currentStatus.publishedAt AS publishedAt, <string> currentStatus.publishedAt AS cursorAt,
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

/**
 * The hearts asked for, newest first, with their public cards (bind `$ids` or `$after`, `$take`
 * and `$show`). api-user's favourites list (GET /v1/account/favourites), in the person's own session; also timed
 * by api-public-read's local scale test.
 */
export const FAVOURITES_SQL = `LET $among = IF $ids != NONE { $ids.map(|$i| type::record('story', $i)) };
   LET $afterId = IF $after != NONE { type::record('favourite', $after) };
   LET $hearts = SELECT record::id(id) AS id, record::id(story) AS story
     FROM favourite
     WHERE person = $auth.id
       AND ($among = NONE OR story IN $among)
       AND ($afterId = NONE OR id < $afterId)
       AND story.currentStatus.status = 'approved'
     ORDER BY id DESC
     LIMIT $take;
   LET $refs = $hearts.slice(0, $show).map(|$h| type::record('story', $h.story));
   RETURN {
     hearts: $hearts,
     cards: IF array::len($refs) > 0 { (SELECT ${SUMMARY_FIELDS} FROM $refs) } ELSE { [] },
   };`;
