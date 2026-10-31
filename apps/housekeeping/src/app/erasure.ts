import {
  PENDING_DELETION_DONE,
  PENDING_DELETION_FAILED,
  PENDING_DELETIONS_DUE,
  type PendingDeletion,
  retryOnConflict,
  runQuery,
} from '@heisreal/database';
import type { Task, TaskContext, TaskResult } from './tasks';

/**
 * The erasures' leftovers (D39, D40, D88), retried every night, at most maxDeletions each, the
 * longest-waiting first. A try that fails counts and waits (1 h, doubling, at most a week:
 * fn::erasure::retry_after), so rows that keep failing go to the back and never hold up the
 * others. Ids in the logs are internal ones only: a user's record id, a pendingDeletion's key.
 */

/** Whoever is due a try, at most `limit`. */
async function due<T>(
  ctx: Pick<TaskContext, 'db'>,
  query: string,
  vars: Record<string, unknown>,
): Promise<T[]> {
  const [found] = (await runQuery(ctx.db, query, vars)) as [T[]];
  return found ?? [];
}

/**
 * Erasure requests (consent_withdrawal_requests_erasure): someone withdrew their testimony or
 * sign-up consent and api-user didn't get to erase them (it failed, or the instance stopped).
 * Deleting the request erases the person, in the database, in the same transaction
 * (erasureRequest_erases), and queues their Bunny videos, pictures and Clerk account for the next
 * chore.
 */
export const erasureRequestsTask: Task = {
  name: 'erasure-requests',
  async run(ctx): Promise<TaskResult> {
    const found = await due<{ key: string }>(
      ctx,
      `SELECT record::id(id) AS key, nextAttemptAt FROM erasureRequest
         WHERE nextAttemptAt <= time::now() ORDER BY nextAttemptAt LIMIT $limit`,
      { limit: ctx.maxDeletions + 1 },
    );
    const selected = found.slice(0, ctx.maxDeletions).map((r) => r.key);
    const result: TaskResult = {
      selected,
      deleted: [],
      failed: [],
      more: found.length > ctx.maxDeletions,
    };
    if (ctx.dryRun) return result;
    for (const key of selected) {
      try {
        await retryOnConflict(
          () =>
            runQuery(ctx.db, `DELETE type::record('erasureRequest', $key)`, {
              key,
            }),
          { attempts: 8 },
        );
        result.deleted.push(key);
      } catch {
        result.failed.push(key);
        await runQuery(
          ctx.db,
          `UPDATE type::record('erasureRequest', $key)
             SET attempts += 1, nextAttemptAt = time::now() + fn::erasure::retry_after(attempts)
             RETURN NONE`,
          { key },
        ).catch(() => undefined);
      }
    }
    return result;
  },
};

/**
 * Queued deletions outside the database (pendingDeletion) that api-user couldn't finish, or that
 * the expired-drafts chore queued: a person's Bunny videos, their pictures (a gone story's folder
 * in the images zone) when the zone's password is set here, and their Clerk account when the
 * Clerk key is.
 */
export const pendingDeletionsTask: Task = {
  name: 'pending-deletions',
  async run(ctx): Promise<TaskResult> {
    // A kind whose key couldn't be read (start.ts logged why) waits, its tries unchanged.
    const kinds = [
      ...(ctx.stream ? ['bunny_video'] : []),
      ...(ctx.images ? ['image'] : []),
      ...(ctx.clerk ? ['clerk_user'] : []),
    ];
    const found = await due<PendingDeletion>(ctx, PENDING_DELETIONS_DUE, {
      kinds,
      keys: null,
      limit: ctx.maxDeletions + 1,
    });
    const selected = found.slice(0, ctx.maxDeletions);
    const result: TaskResult = {
      selected: selected.map((r) => r.key),
      deleted: [],
      failed: [],
      more: found.length > ctx.maxDeletions,
    };
    if (ctx.dryRun) return result;
    for (const row of selected) {
      try {
        if (row.kind === 'bunny_video' && ctx.stream)
          await ctx.stream.delete(row.ref);
        else if (row.kind === 'image' && ctx.images)
          await ctx.images.deleteFolder(row.ref);
        else if (row.kind === 'clerk_user' && ctx.clerk)
          await ctx.clerk.delete(row.ref);
        else throw new Error(`Can't delete a ${row.kind} here`);
      } catch {
        result.failed.push(row.key);
        await runQuery(ctx.db, PENDING_DELETION_FAILED, { key: row.key }).catch(
          () => undefined,
        );
        continue;
      }
      await runQuery(ctx.db, PENDING_DELETION_DONE, { key: row.key });
      result.deleted.push(row.key);
    }
    return result;
  },
};
