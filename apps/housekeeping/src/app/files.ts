import {
  DETACHED_FILE_REMOVED,
  DETACHED_FILES_DUE,
  type DetachedFile,
  OLD_FILE_ROW_DELETE,
  OLD_FILE_ROWS,
  runQuery,
} from '@heisreal/database';
import { STORY_IMAGE_PATH } from '@heisreal/story-cards/upload-signing';
import type { Task, TaskResult } from './tasks';

/** Not a person's file: a picture outside the stories' folders (dev-seed's fixed pictures, which every reset reuses). */
const keep = (f: DetachedFile) =>
  f.format === 'image' && !STORY_IMAGE_PATH.test(f.key);

/**
 * Replaced and removed files (R12; db review 2, section 6 item 7): a video, audio file or picture
 * its story stopped pointing at (storyFile.detachedAt), once no upload link for it can still be
 * used. The file goes at Bunny Stream or in the images zone (already gone is fine: a 404 counts
 * as done, so a dev-seed placeholder's made-up id costs one 404), then its row records
 * removedAt. A picture outside the stories' folders (dev-seed's) is only marked removed, never
 * deleted. A kind whose key couldn't be read waits. Ids in the logs are the Bunny video id or the
 * picture's path.
 */
export const detachedFilesTask: Task = {
  name: 'detached-files',
  async run(ctx): Promise<TaskResult> {
    const [found] = (await runQuery(ctx.db, DETACHED_FILES_DUE, {
      limit: ctx.maxDeletions + 1,
    })) as [DetachedFile[]];
    const due = found ?? [];
    const ready = due
      .slice(0, ctx.maxDeletions)
      .filter(
        (f) => keep(f) || (f.format === 'image' ? ctx.images : ctx.stream),
      );
    const result: TaskResult = {
      selected: ready.map((f) => f.key),
      deleted: [],
      failed: [],
      more: due.length > ctx.maxDeletions || ready.length < due.length,
    };
    if (ctx.dryRun) return result;
    for (const f of ready) {
      try {
        if (!keep(f)) {
          if (f.format === 'image') await ctx.images?.deleteFile(f.key);
          else await ctx.stream?.delete(f.key);
        }
        await runQuery(ctx.db, DETACHED_FILE_REMOVED, { key: f.key });
        result.deleted.push(f.key);
      } catch {
        result.failed.push(f.key);
      }
    }
    return result;
  },
};

/**
 * storyFile rows that no longer count towards the upload limits (7 days, D113) and whose file is
 * removed or whose story is gone (R12). Only rows: no file is deleted here.
 */
export const oldFileRowsTask: Task = {
  name: 'old-file-rows',
  async run(ctx): Promise<TaskResult> {
    const [found] = (await runQuery(ctx.db, OLD_FILE_ROWS, {
      limit: ctx.maxDeletions + 1,
    })) as [string[]];
    const selected = (found ?? []).slice(0, ctx.maxDeletions);
    const result: TaskResult = {
      selected,
      deleted: [],
      failed: [],
      more: (found ?? []).length > ctx.maxDeletions,
    };
    if (ctx.dryRun) return result;
    for (const key of selected) {
      const [gone] = (await runQuery(ctx.db, OLD_FILE_ROW_DELETE, {
        key,
      }).catch(() => [[]])) as [unknown[]];
      if (gone?.length) result.deleted.push(key);
      else result.failed.push(key);
    }
    return result;
  },
};
