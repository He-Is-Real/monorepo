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
 * by the database: {@link ErasedIdentityError}.
 */
export async function provisionPerson(
  db: SurrealQueryable,
  clerkUserId: string,
): Promise<string> {
  return retryOnConflict(async () => {
    const existing = await findPerson(db, clerkUserId);
    if (existing) return existing;
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
