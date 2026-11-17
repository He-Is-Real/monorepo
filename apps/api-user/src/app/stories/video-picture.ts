import { BadRequestException, Logger } from '@nestjs/common';
import {
  DatabaseQueryError,
  retryOnConflict,
  runQuery,
} from '@heisreal/database';
import type { SurrealQueryable } from 'surrealdb';
import type { MediaUrls } from '@heisreal/story-cards';
import type {
  BunnyStream,
  StreamVideo,
} from '@heisreal/story-cards/bunny-stream';
import { StaleVersionException } from './story-store';

/**
 * A video's picture, set at Bunny when the story is sent (Joel, 2026-11-17, P1-13 A: "remove the
 * jobs for picture uploads… If a picture upload fails just ask the user to upload again, before
 * submitting. If picture uploads fails then no submission."). SubmitStory (and sending a story
 * again after Edit) of a video story, after the picture check and the video's own checks, in the
 * same request:
 * - nothing to do when the video's `thumbnailOf` is already the story's picture (or both empty);
 * - otherwise Bunny is told to show the story's picture, fetched through a signed link to the
 *   images zone, or, with no picture any more, its own frame again ({@link BUNNY_FRAME}); then the
 *   video is read back, and the new picture counts only once Bunny names a new thumbnail file;
 * - on success, api-user's own login records the picture as the video's `thumbnailOf` (NONE for
 *   Bunny's frame), which the database allows only for the story being edited's current picture;
 * - all Bunny's calls together get {@link PICTURE_BUDGET_MS}. Bunny down, refusing, too slow, or
 *   the read-back not showing a new file: `400 image_not_uploaded` with {@link PICTURE_FAILED}, and
 *   the story isn't sent (it stays as it was). No retry in the background, and no job.
 */

/** All of Bunny's calls for one picture: setting it and reading it back. */
export const PICTURE_BUDGET_MS = 20_000;

/**
 * Bunny's own frame of the video (Bunny's "Set Thumbnail": the frames it made are named
 * `thumbnail_<n>.jpg`). Checked on dev Bunny on 2026-11-17 (the PR's live test).
 */
export const BUNNY_FRAME = 'thumbnail_1.jpg';

/** What the person sees when Bunny wouldn't take the picture (Joel, P1-13 A). */
export const PICTURE_FAILED =
  'We couldn’t add your picture. Please add it again, then submit.';

const logger = new Logger('VideoPicture');

class PictureNotTaken extends Error {
  override name = 'PictureNotTaken';
}

function pictureFailed(): BadRequestException {
  return new BadRequestException({
    code: 'image_not_uploaded',
    message: PICTURE_FAILED,
  });
}

/**
 * Runs `call` with a signal that aborts after `ms`, and gives up then, whether or not `call`
 * heeds it.
 */
async function within<T>(
  ms: number,
  call: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cutOff = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(new PictureNotTaken(`no answer within ${ms} ms`));
    }, ms);
  });
  try {
    return await Promise.race([call(abort.signal), cutOff]);
  } finally {
    clearTimeout(timer);
  }
}

export interface VideoPicture {
  /** api-user's own login: it records `thumbnailOf`. */
  service: SurrealQueryable;
  bunny: BunnyStream;
  /** Signs the link Bunny fetches the picture through (the images zone's token key); null: off. */
  urls: MediaUrls | null;
  videoId: string;
  /** The story's picture now (its path), or undefined for none. */
  picture: string | undefined;
  /** The video as Bunny showed it just before (its thumbnail's file name). */
  before: StreamVideo;
  budgetMs?: number;
}

/** Sets a video story's picture at Bunny and records it, or refuses the send. */
export async function setVideoPicture({
  service,
  bunny,
  urls,
  videoId,
  picture,
  before,
  budgetMs = PICTURE_BUDGET_MS,
}: VideoPicture): Promise<void> {
  const [recorded] = (await runQuery(
    service,
    `SELECT VALUE IF thumbnailOf != NONE { record::id(thumbnailOf) }
       FROM ONLY type::record('storyFile', $video)`,
    { video: videoId },
  )) as [string | null | undefined];
  const wanted = picture ?? null;
  // Nothing changed since Bunny last took it (a re-send after Edit with the same picture).
  if ((recorded ?? null) === wanted) return;
  try {
    const source =
      wanted === null ? BUNNY_FRAME : (urls?.imageUrl(wanted) ?? null);
    if (!source) throw new PictureNotTaken('picture links are off');
    const after = await within(budgetMs, async (signal) => {
      await bunny.setThumbnail(videoId, source, signal);
      return bunny.video(videoId, signal);
    });
    const shown = after?.thumbnailFileName ?? null;
    if (shown === null || shown === before.thumbnailFileName) {
      throw new PictureNotTaken('Bunny shows no new thumbnail file');
    }
  } catch (err) {
    logger.warn(
      `Bunny didn’t take video ${videoId}’s picture: ${err instanceof Error ? err.message : 'error'}`,
    );
    throw pictureFailed();
  }
  try {
    await retryOnConflict(() =>
      runQuery(
        service,
        `UPDATE type::record('storyFile', $video)
           SET thumbnailOf = IF $picture = NONE { NONE } ELSE { type::record('storyFile', $picture) }
           RETURN NONE`,
        { video: videoId, picture: wanted ?? undefined },
      ),
    );
  } catch (err) {
    // The story moved on meanwhile (another tab changed its picture or sent it).
    if (
      err instanceof DatabaseQueryError &&
      err.message.includes('picture_set:')
    ) {
      throw new StaleVersionException();
    }
    throw err;
  }
}
