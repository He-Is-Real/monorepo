/**
 * Why an account is erased (D39): the audit row's `reason`, one per caller. `account_deleted`
 * is "Delete my account" (also how a person withdraws all consent, plan 4e); `clerk_user_deleted`
 * Clerk's `user.deleted` webhook.
 */
export type ErasureReason = 'account_deleted' | 'clerk_user_deleted';

/**
 * EraseAccount (D39, D82, D40), run by api-user on its own service login in one transaction
 * (docs/db-permissions.md, "Erasure"). Bind `$clerkUserId` and `$reason`. The work is the
 * schema's `fn::account::erase` (the tombstone, the queued deletions outside the database, the
 * stories and everything else of the person's, the stub user row without its agreements, and
 * the audit row).
 *
 * Idempotent: a person already erased (or never known) leaves only the tombstone, which is
 * already there. A run that loses a race to another write fails at commit and must be retried
 * (`retryOnConflict`): the retry erases that write too. Its second-to-last result is
 * `[user, pending]`: the erased user (or NONE) and the keys of the `pendingDeletion`
 * rows it wrote.
 */
export const ERASE_ACCOUNT = `
  BEGIN TRANSACTION;
  LET $erased = fn::account::erase($clerkUserId, $reason);
  $erased;
  COMMIT TRANSACTION;`;

/** A deletion outside the database that was queued (D40): `pendingDeletion`. */
export interface PendingDeletion {
  key: string;
  kind: 'bunny_video' | 'image' | 'clerk_user';
  ref: string;
}

/**
 * Queued deletions due for a try, of the kinds the caller can delete: the ones that have waited
 * longest for their next try first, so rows that keep failing (pushed back each time) never hold
 * up the others. Bind `$kinds`, `$limit` and `$keys`: an array for only those (one erasure's
 * own), or null for any.
 */
export const PENDING_DELETIONS_DUE = `
  SELECT record::id(id) AS key, kind, ref, nextAttemptAt FROM pendingDeletion
    WHERE nextAttemptAt <= time::now() AND kind IN $kinds
      AND (!type::is_array($keys) OR record::id(id) IN $keys)
    ORDER BY nextAttemptAt LIMIT $limit`;

/**
 * One queued deletion is done (bind `$key`): the row goes, or, for a picture folder whose final
 * pass is still to come (a PUT link signed before the story's delete may still be used), it is due
 * again then (fn::erasure::pending_done; the database refuses an earlier removal).
 */
export const PENDING_DELETION_DONE = `fn::erasure::pending_done($key)`;

/** One try failed (bind `$key`): it counts, and the row waits (fn::erasure::retry_after). */
export const PENDING_DELETION_FAILED = `
  UPDATE type::record('pendingDeletion', $key)
    SET attempts += 1, nextAttemptAt = time::now() + fn::erasure::retry_after(attempts)
    RETURN NONE`;
