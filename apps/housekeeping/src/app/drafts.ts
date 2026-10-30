import { retryOnConflict, runQuery } from '@heisreal/database';
import type { Task, TaskContext, TaskResult } from './tasks';

/**
 * D71: a draft nobody has touched for 6 months (not edited, by its `updatedAt`, and no upload
 * link signed for it again, by its grants' `renewedAt`; precisely, the longest
 * `draftRetentionMonths` of the published testimony forms, a month counted as 31 days:
 * fn::story::draft_expired) is deleted, the way a person deletes their own draft: the
 * story row goes, and the database's events delete
 * what hangs off it (story_erasure_cascade) and bump the person's fence. Only drafts: a story
 * that was ever submitted is moderation's or the person's to remove. The database enforces the
 * same rule on service:housekeeping's delete (docs/db-permissions.md), so this query only picks.
 * The draft's Bunny video then has no story, and the orphan-videos chore deletes it (its upload
 * grant stays for the upload limits, D113).
 *
 * Races: a resume signs its link only once its grant's renewal commits, and that conflicts with
 * this delete (both fence the person), as does a testimony form published meanwhile with a longer
 * retention (the delete writes legalFence). The loser of a conflict retries and re-checks.
 */
const EXPIRED = `status = 'draft' AND $cutoff != NONE AND updatedAt < $cutoff
  AND fn::story::draft_expired(id)`;
const CUTOFF = 'LET $cutoff = fn::story::drafts_expire_before();';

/** The oldest expired drafts' ids, at most `limit` (+1, to tell whether there are more). */
export async function expiredDrafts(
  ctx: Pick<TaskContext, 'db'>,
  limit: number,
): Promise<string[]> {
  const [, ids] = (await runQuery(
    ctx.db,
    `${CUTOFF} SELECT VALUE record::id(id) FROM story WHERE ${EXPIRED}
     ORDER BY updatedAt ASC LIMIT $limit`,
    { limit },
  )) as [unknown, string[]];
  return ids ?? [];
}

/** Deletes one, if it's still an expired draft. Answers whether it was deleted. */
async function deleteExpiredDraft(
  ctx: Pick<TaskContext, 'db'>,
  id: string,
): Promise<boolean> {
  // One statement, so the check and the delete read the same snapshot.
  const [gone] = (await retryOnConflict(() =>
    runQuery(
      ctx.db,
      `DELETE type::record('story', $id) WHERE fn::story::draft_expired(id) RETURN BEFORE`,
      { id },
    ),
  )) as [unknown[]];
  return (gone ?? []).length === 1;
}

export const expiredDraftsTask: Task = {
  name: 'expired-drafts',
  async run(ctx): Promise<TaskResult> {
    const found = await expiredDrafts(ctx, ctx.maxDeletions + 1);
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
        // Not deleted: touched or submitted since it was picked. Not a failure.
        if (await deleteExpiredDraft(ctx, id)) result.deleted.push(id);
      } catch {
        result.failed.push(id);
      }
    }
    return result;
  },
};
