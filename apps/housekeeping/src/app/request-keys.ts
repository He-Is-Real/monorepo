import { createHash } from 'node:crypto';
import { retryOnConflict, runQuery } from '@heisreal/database';
import type { Task, TaskContext, TaskResult } from './tasks';

/**
 * R4 (Joel, 2026-11-05): the request keys (`idempotencyKey`, D29: "this request was already
 * done, here was the reply") are useless after `expiresAt`, 24 hours after they were written:
 * nobody resends a request that late. Nothing else removes them (only erasure, a person's own),
 * so this deletes every expired key, whoever it belongs to: a person's, a Clerk or Stripe
 * webhook's, an admin's. The database lets service:housekeeping read and delete only expired
 * keys (docs/db-permissions.md), so this query only picks.
 *
 * A key is a tiny row, so a run deletes up to `KEYS_PER_DELETION` times maxDeletions of them, in
 * batches of maxDeletions. A key's id holds the key the browser or webhook sent, so the logs get
 * a short hash of each id instead, never the id itself.
 */
const KEYS_PER_DELETION = 20;

const label = (id: unknown) =>
  createHash('sha256').update(String(id)).digest('hex').slice(0, 16);

/** The longest-expired keys' ids, at most `limit`. */
async function expiredKeys(
  ctx: Pick<TaskContext, 'db'>,
  limit: number,
): Promise<unknown[]> {
  const [ids] = (await runQuery(
    ctx.db,
    `SELECT VALUE id FROM idempotencyKey WHERE expiresAt < time::now()
       ORDER BY expiresAt ASC LIMIT $limit`,
    { limit },
  )) as [unknown[]];
  return ids ?? [];
}

/**
 * Deletes the `count` longest-expired keys that are still expired. Picked again in the same
 * query: the ids come back to this process as text, which a DELETE can't use. Answers the ids
 * deleted.
 */
async function deleteExpired(
  ctx: Pick<TaskContext, 'db'>,
  count: number,
): Promise<unknown[]> {
  // A person's key bumps their fence when it goes (idempotencyKey_owner), so this may conflict
  // with that person's own write at the same moment: the retry picks and re-checks again.
  const results = await retryOnConflict(() =>
    runQuery(
      ctx.db,
      `LET $ids = (SELECT VALUE id FROM idempotencyKey WHERE expiresAt < time::now()
         ORDER BY expiresAt ASC LIMIT $count);
       DELETE $ids WHERE expiresAt < time::now() RETURN BEFORE`,
      { count },
    ),
  );
  return ((results.at(-1) as { id: unknown }[]) ?? []).map((r) => r.id);
}

export const expiredRequestKeysTask: Task = {
  name: 'expired-request-keys',
  async run(ctx): Promise<TaskResult> {
    const max = ctx.maxDeletions * KEYS_PER_DELETION;
    const found = await expiredKeys(ctx, max + 1);
    const selected = found.slice(0, max);
    const result: TaskResult = {
      selected: selected.map(label),
      deleted: [],
      failed: [],
      more: found.length > max,
    };
    if (ctx.dryRun) return result;
    for (let i = 0; i < selected.length; i += ctx.maxDeletions) {
      const batch = selected.slice(i, i + ctx.maxDeletions);
      try {
        result.deleted.push(
          ...(await deleteExpired(ctx, batch.length)).map(label),
        );
      } catch {
        result.failed.push(...batch.map(label));
      }
    }
    return result;
  },
};
