import { retryOnConflict, runQuery } from '@heisreal/database';
import type { Task, TaskContext, TaskResult } from './tasks';

/**
 * G3 B (Joel, 2026-11-11, "More M3 answers"): stories that were sent at least once but will never
 * be published are deleted once they are old enough, the way a person deletes their own story:
 *
 * - `rejected-stories`: a rejected story, the settings' `rejectedRetentionDays` (90) after its
 *   rejection (the person can download the feedback until then);
 * - `abandoned-stories`: a story left in editing after it was sent (sent back, its file unusable,
 *   or taken down to edit), the settings' `editingRetentionDays` (186) after it was last touched,
 *   by the drafts' clock (its last write, or the last upload link signed for it again).
 *
 * Admins change both on the Limits page. The database holds the one rule
 * (fn::story::deletes_at, fn::story::deletion_due) and enforces it on service:housekeeping's delete
 * (docs/db-permissions.md), so these queries only pick. The story row goes, and the database's
 * events delete what hangs off it (story_erasure_cascade), queue its picture folder and bump the
 * person's fence; its Bunny video then has no story, and the orphan-videos chore deletes it.
 *
 * Races: editing the story, sending it or resuming an upload fences the person, as this delete
 * does, so they conflict; the loser retries and re-checks.
 */
function oldStoriesTask(name: string, status: 'rejected' | 'editing'): Task {
  /**
   * The longest-untouched due stories' ids, at most `limit`. The status first; the database's
   * rule decides.
   */
  const due = async (
    ctx: Pick<TaskContext, 'db'>,
    limit: number,
  ): Promise<string[]> => {
    const [ids] = (await runQuery(
      ctx.db,
      `SELECT VALUE record::id(id) FROM story
         WHERE currentStatus != NONE AND currentStatus.status = $status
           AND fn::story::deletion_due(id)
         ORDER BY updatedAt ASC LIMIT $limit`,
      { status, limit },
    )) as [string[]];
    return ids ?? [];
  };

  /** Deletes one, if it's still due. Answers whether it was deleted. */
  const deleteDue = async (
    ctx: Pick<TaskContext, 'db'>,
    id: string,
  ): Promise<boolean> => {
    // One statement, so the check and the delete read the same snapshot.
    const results = await retryOnConflict(() =>
      runQuery(
        ctx.db,
        `RETURN array::len(DELETE type::record('story', $id)
           WHERE fn::story::deletion_due(id) RETURN BEFORE);`,
        { id },
      ),
    );
    return results[results.length - 1] === 1;
  };

  return {
    name,
    async run(ctx): Promise<TaskResult> {
      const found = await due(ctx, ctx.maxDeletions + 1);
      const selected = found.slice(0, ctx.maxDeletions);
      const result: TaskResult = {
        selected,
        deleted: [],
        failed: [],
        more: found.length > ctx.maxDeletions,
      };
      if (ctx.dryRun) return result;
      for (const id of selected) {
        try {
          // Not deleted: touched, sent or deleted since it was picked. Not a failure.
          if (await deleteDue(ctx, id)) result.deleted.push(id);
        } catch {
          result.failed.push(id);
        }
      }
      return result;
    },
  };
}

export const rejectedStoriesTask = oldStoriesTask(
  'rejected-stories',
  'rejected',
);
export const abandonedStoriesTask = oldStoriesTask(
  'abandoned-stories',
  'editing',
);
