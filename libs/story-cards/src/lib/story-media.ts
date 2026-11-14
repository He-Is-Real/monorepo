import type { BunnyStream } from './bunny-stream';

/**
 * How long a Delete waits for Bunny, in milliseconds: all its deletions together, comfortably below
 * the browser's 30 s deadline (apps/web/src/lib/api-user.ts). Each service provides it under
 * STORY_MEDIA_BUDGET_MS, so its integration tests can use a shorter one.
 */
export const STORY_MEDIA_BUDGET_MS = Symbol('STORY_MEDIA_BUDGET_MS');
export const DEFAULT_STORY_MEDIA_BUDGET_MS = 8_000;

/** What deleting a gone story's media at Bunny needs: each null when off in that service. */
export interface DeletedStoryMedia {
  /** Bunny Stream, for the story's videos. */
  stream: Pick<BunnyStream, 'deleteVideo'> | null;
  /** The images zone, for the story's picture folder `stories/<id>/`. */
  folders: { deleteFolder(folder: string): Promise<void> } | null;
  budgetMs: number;
  logger: { warn(message: string): void };
}

/**
 * A deleted story's files at Bunny, at once (D71; DEL-1 for an Admin's Delete and OD-1 for the
 * owner's, Joel 2026-11-14): its videos at Bunny Stream and its picture folder in the images zone.
 * Only after the delete has committed, and it never fails the Delete: the deletions run side by
 * side under one time budget, and a video or folder that couldn't go, or hadn't gone when the
 * budget ran out, is logged (internal ids only) and left to the nightly clean-up, the orphan sweep
 * for videos and the queued folder (pendingDeletion, story_picture_folder) for pictures
 * (docs/media-runbook.md).
 */
export async function discardDeletedStoryMedia(
  { stream, folders, budgetMs, logger }: DeletedStoryMedia,
  storyId: string,
  videos: string[],
): Promise<void> {
  const folder = `stories/${storyId}/`;
  const unfinished = new Set<string>();
  const track = (what: string, work: Promise<void>) => {
    unfinished.add(what);
    return work.finally(() => unfinished.delete(what));
  };
  const reason = (e: unknown) => (e instanceof Error ? e.message : 'error');
  const work: Promise<void>[] = videos.map((id) => {
    if (!stream) {
      logger.warn(
        `Couldn’t delete the deleted story’s video ${id} (Bunny Stream is off here; an orphan until the sweep)`,
      );
      return Promise.resolve();
    }
    return track(
      `the deleted story’s video ${id} (an orphan until the sweep)`,
      stream
        .deleteVideo(id)
        .catch((e: unknown) =>
          logger.warn(
            `Couldn’t delete the deleted story’s video ${id} (an orphan until the sweep): ${reason(e)}`,
          ),
        ),
    );
  });
  if (!folders) {
    logger.warn(
      `Couldn’t delete ${folder} (the images zone is off here; housekeeping deletes it from the queue)`,
    );
  } else {
    work.push(
      track(
        `${folder} (housekeeping deletes it from the queue)`,
        folders
          .deleteFolder(folder)
          .catch((e: unknown) =>
            logger.warn(
              `Couldn’t delete ${folder} (housekeeping deletes it from the queue): ${reason(e)}`,
            ),
          ),
      ),
    );
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outOfTime = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), budgetMs);
  });
  const result = await Promise.race([
    Promise.all(work).then(() => 'done' as const),
    outOfTime,
  ]);
  clearTimeout(timer);
  if (result === 'late') {
    for (const what of unfinished) {
      logger.warn(
        `Couldn’t delete ${what}: Bunny hadn’t answered within ${budgetMs / 1000} s`,
      );
    }
  }
}
