/**
 * Why an account is erased (D39): the audit row's `reason`, one per caller. `account_deleted`
 * is "Delete my account"; `consent_withdrawn` withdrawing the testimony (Art 9) or sign-up consent
 * (D88, D73); `clerk_user_deleted` Clerk's `user.deleted` webhook.
 */
export type ErasureReason =
  | 'account_deleted'
  | 'consent_withdrawn'
  | 'clerk_user_deleted';

/**
 * EraseAccount (D39, D82, D40), run by api-user on its own service login in one transaction
 * (docs/db-permissions.md, "Erasure"). Bind `$clerkUserId` and `$reason`.
 *
 * - The erased-identity tombstone (D82): the sha256 of the Clerk id, written even when nobody has
 *   that id, so provisioning refuses it from now on (`user_not_erased_identity`).
 * - What must go outside the database (D40): each of the person's upload grants as a
 *   `pendingDeletion` (`bunny_video`, or `image` for an image grant), and, unless Clerk has
 *   already deleted the person (the webhook), their Clerk account (`clerk_user`).
 * - Then the stories (the cascade takes publicStory, hiddenStory, reviews and others' hearts),
 *   idempotency keys, limits, submission log and grants; the user row becomes a stub (D37) and
 *   their own hearts go with it (`user_erasure_favourites`); an `EraseAccount` audit row.
 *
 * Idempotent: a person already erased (or never known) leaves only the tombstone, which is
 * already there. A run that loses a race to another write fails at commit and must be retried
 * (`retryOnConflict`): the retry erases that write too. Its second-to-last result is
 * `[user, pending]`: the erased user (or NONE) and the keys of the `pendingDeletion`
 * rows it wrote.
 */
export const ERASE_ACCOUNT = `
  BEGIN TRANSACTION;
  LET $fingerprint = type::record('erasedIdentity', crypto::sha256($clerkUserId));
  IF !record::exists($fingerprint) { CREATE $fingerprint RETURN NONE };
  LET $u = (SELECT VALUE id FROM user WHERE clerkUserId = $clerkUserId AND gdprDeletedAt = NONE)[0];
  LET $media = (SELECT VALUE { kind: IF format = 'image' { 'image' } ELSE { 'bunny_video' },
      ref: <string> record::id(id) } FROM uploadGrant WHERE $u != NONE AND person = $u);
  LET $account = IF $u = NONE OR $reason = 'clerk_user_deleted' { [] }
    ELSE { [{ kind: 'clerk_user', ref: $clerkUserId }] };
  LET $pending = IF array::len(array::concat($media, $account)) = 0 { [] }
    ELSE { (INSERT INTO pendingDeletion array::concat($media, $account) RETURN VALUE record::id(id)) };
  IF $u != NONE {
    DELETE story WHERE submitter = $u;              -- cascades publicStory, hiddenStory, reviews, hearts
    DELETE idempotencyKey WHERE record::id(id)[1] = $u;   -- keys are scoped by user record
    DELETE submitterLimits WHERE user = $u;         -- D112: their limits and trusted mark
    DELETE submissionLog WHERE person = $u;         -- D113: their recent submissions
    DELETE uploadGrant WHERE person = $u;           -- D80, D113: their uploads (queued above, D40)
    UPDATE $u SET gdprDeletedAt = time::now(), clerkUserId = NONE;   -- D37: a stub remains
    CREATE auditLog CONTENT { service: 'api-user', action: 'EraseAccount', entity: $u,
      reason: $reason };
  };
  [$u, $pending];
  COMMIT TRANSACTION;`;
