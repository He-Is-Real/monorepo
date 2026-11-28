import { note } from '@heisreal/logging/event';
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
}

/**
 * A deleted story's files at Bunny, at once (D71; DEL-1 for an Admin's Delete and OD-1 for the
 * owner's, Joel 2026-11-14): its videos at Bunny Stream and its picture folder in the images zone.
 * Only after the delete has committed, and it never fails the Delete: the deletions run side by
 * side under one time budget, and a video or folder that couldn't go, or hadn't gone when the
 * budget ran out, is recorded on the request's event (`story.media_left`, internal ids only) and left to the nightly clean-up, the orphan sweep
 * for videos and the queued folder (pendingDeletion, story_picture_folder) for pictures
 * (docs/runbooks/media.md).
 */
export async function discardDeletedStoryMedia(
  { stream, folders, budgetMs }: DeletedStoryMedia,
  storyId: string,
  videos: string[],
): Promise<void> {
  const folder = `stories/${storyId}/`;
  // What is left to the nightly clean-up, and why (`off`, `timeout`, or the error's name).
  const left = new Map<string, string>();
  const unfinished = new Set<string>();
  const track = (what: string, work: Promise<void>) => {
    unfinished.add(what);
    return work
      .catch((e: unknown) => {
        left.set(what, e instanceof Error ? e.name : 'error');
      })
      .finally(() => unfinished.delete(what));
  };
  const work: Promise<void>[] = videos.map((id) =>
    stream
      ? track(id, stream.deleteVideo(id))
      : (left.set(id, 'off'), Promise.resolve()),
  );
  if (!folders) left.set(folder, 'off');
  else work.push(track(folder, folders.deleteFolder(folder)));
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
    for (const what of unfinished) left.set(what, 'timeout');
  }
  if (!left.size) return;
  // Videos: an orphan until the sweep; the folder: housekeeping deletes it from the queue.
  note(
    {
      story: {
        id: storyId,
        media_left: [...left].map(([what, reason]) => ({
          what: what === folder ? 'folder' : what,
          reason,
        })),
      },
    },
    {
      severity: 'WARNING',
      message: 'A deleted story’s media is left to the nightly clean-up',
    },
  );
}
