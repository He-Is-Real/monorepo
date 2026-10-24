'use server';

import { browseStories, type StoryPage } from '@/lib/browse';
import { sanitizeFilters, toBrowseParams } from '@/lib/browse-query';
import { getPublicStory, StoriesUnavailableError } from '@/lib/public-stories';
import { playerSrc } from '@/components/stories/story-media';

/** The API's own cursor limit (browse.query.ts, CURSOR_MAX_CHARS). */
const CURSOR_MAX_CHARS = 300;

/**
 * The browse page's next page (D55), fetched by web's server from api-public-read like every
 * other page (D32): the browser never calls the API for stories. Anyone can call a server
 * action, so its input is checked again here. Failures answer `{ ok: false }` (the page offers
 * "Try again"); a cursor from other filters is one (the API answers 400).
 */
export async function loadMoreStories(
  filters: unknown,
  cursor: unknown,
): Promise<{ ok: true; page: StoryPage } | { ok: false }> {
  if (
    typeof cursor !== 'string' ||
    cursor.length === 0 ||
    cursor.length > CURSOR_MAX_CHARS
  )
    return { ok: false };
  const f = sanitizeFilters(
    typeof filters === 'object' && filters !== null ? filters : {},
  );
  try {
    return { ok: true, page: await browseStories(toBrowseParams(f, cursor)) };
  } catch (err) {
    if (err instanceof StoriesUnavailableError) return { ok: false };
    throw err;
  }
}

export type CardPlayerResult =
  { ok: true; src: string } | { ok: false; reason: 'gone' | 'unavailable' };

/**
 * A card's player link, signed on demand (card playback, delivery-status): browse and home
 * cards never carry one, so links are signed only for stories someone chose to play. web's
 * server reads the story from api-public-read like the story page does (D32), and the link is
 * the one that page would show, with autoplay on: this runs only when someone presses play.
 * A story that has gone (hidden, withdrawn) answers `gone`; anything else that fails,
 * `unavailable`.
 */
export async function cardPlayer(slug: unknown): Promise<CardPlayerResult> {
  if (typeof slug !== 'string') return { ok: false, reason: 'gone' };
  try {
    const result = await getPublicStory(slug);
    if (result.kind === 'not_found') return { ok: false, reason: 'gone' };
    const url = result.story.media?.[0]?.playbackUrl;
    const src = url ? playerSrc(url, { autoplay: true }) : null;
    return src ? { ok: true, src } : { ok: false, reason: 'unavailable' };
  } catch (err) {
    if (err instanceof StoriesUnavailableError)
      return { ok: false, reason: 'unavailable' };
    throw err;
  }
}
