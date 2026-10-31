import { runQuery } from '@heisreal/database';
import type { LibraryVideo } from './stream';
import type { Task, TaskContext, TaskResult } from './tasks';

/**
 * Orphaned story videos (docs/media-runbook.md, "Replaced and orphaned videos"): a video in the
 * stories' Stream library that no story shows. A video is deleted only if all of these hold:
 *
 * - it's a story video: titled with a story id (a ULID, D69), in no collection. So site videos
 *   (the `site-assets` collection) and dev-seed's clips (`dev-seed/clip-NN`) are never touched;
 * - Bunny made it more than 48 hours ago, so an upload in progress, a draft that's just been
 *   given it, and an upload whose outcome api-user couldn't tell (settled by the person's retry
 *   within the idempotency key's 24 hours) are left alone;
 * - no story's and no published story's media names it, and no upload grant made or renewed (a
 *   resume signed its link again) in the last 48 hours does.
 *
 * The database's answer is read in one transaction (a snapshot), after Bunny's list: a video
 * Bunny listed can only be given to a story later through a new upload, which makes a new video.
 */
export const MIN_AGE_HOURS = 48;
const STORY_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Every Bunny video id the database still refers to. */
export async function referencedVideoIds(
  ctx: Pick<TaskContext, 'db'>,
): Promise<Set<string>> {
  const results = await runQuery(
    ctx.db,
    `BEGIN TRANSACTION;
     LET $stories = array::flatten(SELECT VALUE media.bunnyVideoId FROM story);
     LET $published = array::flatten(SELECT VALUE media.bunnyVideoId FROM publicStory);
     LET $granted = SELECT VALUE record::id(id) FROM uploadGrant
       WHERE at > time::now() - ${MIN_AGE_HOURS}h
         OR (renewedAt != NONE AND renewedAt > time::now() - ${MIN_AGE_HOURS}h);
     RETURN array::distinct(array::concat($stories, $published, $granted));
     COMMIT TRANSACTION;`,
  );
  const ids = results[results.length - 2] as unknown[];
  if (!Array.isArray(ids)) {
    throw new Error('The database answered no video ids');
  }
  return new Set(ids.filter((id): id is string => typeof id === 'string'));
}

/** Which of Bunny's videos are orphans, oldest first (see above). */
export function orphanVideos(
  videos: readonly LibraryVideo[],
  referenced: ReadonlySet<string>,
  now: Date,
): LibraryVideo[] {
  const before = now.getTime() - MIN_AGE_HOURS * 3600_000;
  return videos
    .filter(
      (v) =>
        STORY_ID.test(v.title) &&
        v.collectionId === null &&
        v.created !== null &&
        v.created.getTime() < before &&
        !referenced.has(v.guid),
    )
    .sort((a, b) => (a.created?.getTime() ?? 0) - (b.created?.getTime() ?? 0));
}

export const orphanVideosTask: Task = {
  name: 'orphan-videos',
  async run(ctx): Promise<TaskResult> {
    // Without Bunny's key (start.ts logged why) the sweep waits for the next run.
    if (!ctx.stream)
      return { selected: [], deleted: [], failed: [], more: true };
    const { videos, complete } = await ctx.stream.list();
    const referenced = await referencedVideoIds(ctx);
    const orphans = orphanVideos(videos, referenced, ctx.now);
    const selected = orphans.slice(0, ctx.maxDeletions).map((v) => v.guid);
    const result: TaskResult = {
      selected,
      deleted: [],
      failed: [],
      more: orphans.length > ctx.maxDeletions || !complete,
    };
    if (ctx.dryRun) return result;
    for (const guid of selected) {
      try {
        await ctx.stream.delete(guid);
        result.deleted.push(guid);
      } catch {
        result.failed.push(guid);
      }
    }
    return result;
  },
};
