import { BadRequestException } from '@nestjs/common';
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
import { currentEvent } from '@heisreal/logging/event';

/**
 * A video's picture, set at Bunny when the story is sent (Joel, 2026-11-17, P1-13 A: "remove the
 * jobs for picture uploads… If a picture upload fails just ask the user to upload again, before
 * submitting. If picture uploads fails then no submission."). SubmitStory (and sending a story
 * again after Edit) of a video story, after the picture check and the video's own checks, in the
 * same request:
 * - nothing to do when the video's `thumbnailOf` is already the story's picture and Bunny still
 *   shows the thumbnail file recorded in its `thumbnailPath`: both are recorded only once Bunny
 *   was read back showing it, and a picture's path is never used again;
 * - with no picture and nothing recorded, nothing to do only while Bunny still shows the video's
 *   untouched first thumbnail ({@link BUNNY_UNTOUCHED}): an earlier Submit may have set a picture
 *   at Bunny and then lost the read-back, which recorded nothing (Codex, #233 review);
 * - otherwise Bunny is told to show the story's picture, fetched through a signed link to the
 *   images zone that expires {@link PICTURE_LINK_SECONDS} after it's made (RE-4 A), or, with no picture any more, its own frame again ({@link BUNNY_FRAME}); then the
 *   video is read back, and the new picture counts only once Bunny names a new thumbnail file;
 * - on success, api-user's own login records the picture as the video's `thumbnailOf` (NONE for
 *   Bunny's frame), which the database allows only for the story being edited's current picture,
 *   and, in the same write, the thumbnail file Bunny's read-back named as its `thumbnailPath`,
 *   `<video id>/<file name>` (Joel, 2026-11-17, RE-2 B). Nothing needs doing at Bunny only while
 *   it shows ({@link VideoPicture.before}) exactly the file already recorded there: any other name
 *   is a picture that reached Bunny late (a send that timed out, another tab), so the picture is
 *   set and read back again. A name Bunny shows that our own confirmed write didn't produce is
 *   never recorded (the untouched thumbnail of a video never given a picture aside). api-admin's
 *   approval compares the recorded name with what Bunny shows then: a late change is refused,
 *   never published unseen;
 * - all Bunny's calls together get {@link PICTURE_BUDGET_MS}. Bunny down, refusing, too slow, or
 *   the read-back not showing a new file: `400 image_not_uploaded` with {@link PICTURE_FAILED}, and
 *   the story isn't sent (it stays as it was). No retry in the background, and no job.
 */

/** All of Bunny's calls for one picture: setting it and reading it back. */
export const PICTURE_BUDGET_MS = 20_000;

/**
 * How long the link Bunny fetches the picture through lasts (Joel, 2026-11-17, RE-4 A): signed
 * right before the set call, it expires 15 seconds later (16 at most: the signer rounds up to the
 * second), before {@link PICTURE_BUDGET_MS} runs out. So a set call this send has given up on can't
 * fetch the picture afterwards: Bunny refuses a link that has expired ("Origin returned HTTP 403",
 * the thumbnail unchanged; checked on dev Bunny on 2026-11-17, where it fetched a 5-second link at
 * once, 1.3–2.4 s, five runs out of five). Only this link: pages' own picture links keep theirs.
 * The link lifetime must stay below the budget.
 */
export const PICTURE_LINK_SECONDS = 15;

/**
 * Bunny's own frame of the video (Bunny's "Set Thumbnail": the frames it made are named
 * `thumbnail_<n>.jpg`). Checked on dev Bunny on 2026-11-17 (the PR's live test).
 */
export const BUNNY_FRAME = 'thumbnail_1.jpg';

/**
 * The thumbnail file Bunny names for a video nobody has set a picture for: from its creation,
 * while encoding and after. Every picture set (ours, or its frame put back) gets a new
 * `thumbnail_<random>.jpg` instead. Checked on dev Bunny on 2026-11-17 (#233 round 2).
 */
export const BUNNY_UNTOUCHED = 'thumbnail.jpg';

/** What the person sees when Bunny wouldn't take the picture (Joel, P1-13 A). */
export const PICTURE_FAILED =
  'We couldn’t add your picture. Please add it again, then submit.';

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
    `SELECT IF thumbnailOf != NONE { record::id(thumbnailOf) } AS picture, thumbnailPath AS path
       FROM ONLY type::record('storyFile', $video)`,
    { video: videoId },
  )) as [{ picture?: string | null; path?: string | null } | undefined];
  const wanted = picture ?? null;
  const shownBefore = before.thumbnailFileName
    ? `${videoId}/${before.thumbnailFileName}`
    : null;
  const recordedPath = recorded?.path ?? null;
  // Nothing changed since Bunny last took it (a re-send after Edit with the same picture): only
  // while Bunny still shows the very file our own confirmed write recorded. Any other name there
  // is a change that reached Bunny late (a send that timed out, another tab), never accepted
  // (RE-2 B): the picture is set again and read back. With no picture, a video Bunny has never
  // been given one (its untouched thumbnail, nothing recorded) is kept, and recorded; any other
  // picture there gets Bunny's frame back (a frame put back gets a new name).
  if ((recorded?.picture ?? null) === wanted) {
    if (shownBefore !== null && shownBefore === recordedPath) return;
    if (
      wanted === null &&
      recordedPath === null &&
      before.thumbnailFileName === BUNNY_UNTOUCHED &&
      shownBefore !== null
    ) {
      await record(service, videoId, { thumbnailPath: shownBefore });
      return;
    }
  }
  let shown: string;
  try {
    if (wanted !== null && !urls?.imageUrl(wanted)) {
      throw new PictureNotTaken('picture links are off');
    }
    const after = await within(budgetMs, async (signal) => {
      // Signed right before the call, so the link expires inside the budget (RE-4 A).
      const source =
        wanted === null
          ? BUNNY_FRAME
          : urls?.expiringIn(PICTURE_LINK_SECONDS).imageUrl(wanted);
      if (!source) throw new PictureNotTaken('picture links are off');
      await bunny.setThumbnail(videoId, source, signal);
      return bunny.video(videoId, signal);
    });
    const name = after?.thumbnailFileName ?? null;
    if (name === null || name === before.thumbnailFileName) {
      throw new PictureNotTaken('Bunny shows no new thumbnail file');
    }
    shown = name;
  } catch (err) {
    currentEvent()?.set({
      upload: { video_id: videoId },
      error: {
        type: 'PictureNotTaken',
        message: err instanceof Error ? err.message : 'error',
      },
    });
    throw pictureFailed();
  }
  await record(service, videoId, {
    picture: wanted,
    thumbnailPath: `${videoId}/${shown}`,
  });
}

/**
 * api-user's one write to the video's row: its `thumbnailPath` (RE-2 B), and its `thumbnailOf`
 * when `picture` is given (null: Bunny's own frame). Only a path that changes is written.
 */
async function record(
  service: SurrealQueryable,
  videoId: string,
  {
    picture,
    thumbnailPath,
  }: { picture?: string | null; thumbnailPath: string },
): Promise<void> {
  try {
    await retryOnConflict(() =>
      runQuery(
        service,
        `UPDATE type::record('storyFile', $video)
           SET thumbnailOf = IF !$setPicture { thumbnailOf }
               ELSE IF $picture = NONE { NONE } ELSE { type::record('storyFile', $picture) },
             thumbnailPath = $thumbnailPath
           WHERE thumbnailPath != $thumbnailPath OR $setPicture
           RETURN NONE`,
        {
          video: videoId,
          setPicture: picture !== undefined,
          picture: picture ?? undefined,
          thumbnailPath,
        },
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
