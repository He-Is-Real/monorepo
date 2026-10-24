'use server';

import { browseStories, type StoryPage } from '@/lib/browse';
import { sanitizeFilters, toBrowseParams } from '@/lib/browse-query';
import { StoriesUnavailableError } from '@/lib/public-stories';

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
