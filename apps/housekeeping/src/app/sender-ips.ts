import { retryOnConflict, runQuery } from '@heisreal/database';
import type { Task, TaskContext, TaskResult } from './tasks';

/**
 * The block list (G21 D, Joel 2026-11-11): the IP address each story is sent from
 * (`storyStatusLog.senderIp`) is kept 30 days, so an Admin can block a recent abuser's address,
 * then cleared. The database lets service:housekeeping see only status entries still holding an
 * address 30 days old (`fn::story::sender_ips_expire_before`), never the address itself, and
 * change nothing but clearing it (docs/db-permissions.md), so these queries only pick. The entry
 * itself stays: the story's status log is append-only.
 *
 * Clearing is tiny, so a run clears up to `ENTRIES_PER_DELETION` times maxDeletions entries, in
 * batches of maxDeletions. Logs carry the entries' ids (ULIDs), never an address.
 */
const ENTRIES_PER_DELETION = 20;

/** Ids of entries whose address is due to be cleared, at most `limit`. */
async function dueEntries(
  ctx: Pick<TaskContext, 'db'>,
  limit: number,
): Promise<string[]> {
  // Only "sent" (pending) entries carry an address; the status index keeps the scan to them.
  const [ids] = (await runQuery(
    ctx.db,
    `SELECT VALUE record::id(id) FROM storyStatusLog WITH INDEX storyStatusLog_queue
       WHERE status = 'pending' LIMIT $limit`,
    { limit },
  )) as [string[]];
  return ids ?? [];
}

/**
 * Clears the address on up to `count` due entries (picked again in the same query, still due).
 * Answers the ids cleared.
 */
async function clearDue(
  ctx: Pick<TaskContext, 'db'>,
  count: number,
): Promise<string[]> {
  const results = await retryOnConflict(() =>
    runQuery(
      ctx.db,
      `LET $ids = (SELECT VALUE id FROM storyStatusLog WITH INDEX storyStatusLog_queue
         WHERE status = 'pending' LIMIT $count);
       UPDATE $ids SET senderIp = NONE RETURN NONE;
       -- A cleared entry is no longer housekeeping's to see, so the ones still seen weren't.
       LET $left = (SELECT VALUE id FROM $ids);
       RETURN $ids.filter(|$i| $i NOT IN $left).map(|$i| record::id($i));`,
      { count },
    ),
  );
  return (results.at(-1) as string[]) ?? [];
}

export const oldSenderIpsTask: Task = {
  name: 'old-sender-ips',
  async run(ctx): Promise<TaskResult> {
    const max = ctx.maxDeletions * ENTRIES_PER_DELETION;
    const found = await dueEntries(ctx, max + 1);
    const selected = found.slice(0, max);
    const result: TaskResult = {
      selected,
      deleted: [],
      failed: [],
      more: found.length > max,
    };
    if (ctx.dryRun) return result;
    for (let i = 0; i < selected.length; i += ctx.maxDeletions) {
      const batch = selected.slice(i, i + ctx.maxDeletions);
      try {
        result.deleted.push(...(await clearDue(ctx, batch.length)));
      } catch {
        result.failed.push(...batch);
      }
    }
    return result;
  },
};
