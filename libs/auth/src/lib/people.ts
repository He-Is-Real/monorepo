import type { SurrealQueryable } from 'surrealdb';
import { retryOnConflict, runQuery } from '@heisreal/database';

/**
 * Who creates a person's `user` row, and with what rights (D13, D27). SurrealDB's
 * `DEFINE ACCESS clerk` only opens sessions for people it already knows, so the row must exist
 * before the person's first query. The schema lets exactly one identity create users:
 * `service:api_user` (`user` PERMISSIONS `FOR create`). A person can't create their own row,
 * and api-admin can't create rows at all. These helpers run on the service's own login, never
 * in the person's session, and only after the token has been verified.
 */

const FIND = `SELECT VALUE id FROM user WHERE clerkUserId = $clerkUserId LIMIT 1`;
const CREATE = `CREATE user SET clerkUserId = $clerkUserId RETURN VALUE id`;

/**
 * The database refused the Clerk id because that account was erased (D82: `erasedIdentity`,
 * `user_not_erased_identity`). A token minted before erasure, or a Clerk account whose deletion
 * hasn't gone through yet, never gets a row again.
 */
export class ErasedIdentityError extends Error {
  override name = 'ErasedIdentityError';
}

/**
 * The block list (G21 D, Joel 2026-11-11): the email is blocked, so it can't create an account
 * (on our side: its `user` row is never made). A person who already has a row isn't refused here;
 * a blocked email can't send a story either (api-user checks at submit).
 */
export class BlockedEmailError extends Error {
  override name = 'BlockedEmailError';
}

/**
 * Whether `value` is on the block list's `table` (`blockedEmail` or `blockedIp`). api-user's login
 * may read only the one row the query names in `$blockCheck`, never the list
 * (docs/db-permissions.md). Values are compared exactly; callers pass them lower-case.
 */
export async function isBlocked(
  db: SurrealQueryable,
  table: 'blockedEmail' | 'blockedIp',
  value: string | undefined,
): Promise<boolean> {
  if (!value) return false;
  const [ids] = (await runQuery(
    db,
    `SELECT VALUE id FROM type::record($table, $blockCheck)`,
    { table, blockCheck: value },
  )) as [unknown[]];
  return ids.length > 0;
}

const isErasedIdentity = (err: unknown) =>
  /identity_erased/.test(err instanceof Error ? err.message : String(err));

const isUniqueViolation = (err: unknown) =>
  /user_clerk|already contains/i.test(
    err instanceof Error ? err.message : String(err),
  );

/** The person's `user` id (`user:…`), or undefined. Readable by api-user and api-admin. */
export async function findPerson(
  db: SurrealQueryable,
  clerkUserId: string,
): Promise<string | undefined> {
  const [ids] = (await runQuery(db, FIND, { clerkUserId })) as [string[]];
  return ids[0];
}

/**
 * api-user only: the person's `user` id, creating the row on first use. Concurrent first
 * requests are safe: the `user_clerk` unique index lets one create win, and the loser reads
 * the winner's row. A fence conflict (`user_fence`) is retried. An erased Clerk id is refused
 * by the database: {@link ErasedIdentityError}. A new row isn't made for a blocked `email` (the
 * token's verified email, when it has one): {@link BlockedEmailError}.
 */
export async function provisionPerson(
  db: SurrealQueryable,
  clerkUserId: string,
  { email }: { email?: string } = {},
): Promise<string> {
  return retryOnConflict(async () => {
    const existing = await findPerson(db, clerkUserId);
    if (existing) return existing;
    if (await isBlocked(db, 'blockedEmail', email)) {
      throw new BlockedEmailError();
    }
    try {
      const [created] = (await runQuery(db, CREATE, { clerkUserId })) as [
        string[],
      ];
      if (created.length === 1) return created[0];
    } catch (err) {
      if (isErasedIdentity(err)) throw new ErasedIdentityError(clerkUserId);
      if (!isUniqueViolation(err)) throw err;
    }
    // Lost a race to another request for the same person, or the create was refused.
    const winner = await findPerson(db, clerkUserId);
    if (!winner) {
      throw new Error(`The user row for ${clerkUserId} could not be created`);
    }
    return winner;
  });
}
