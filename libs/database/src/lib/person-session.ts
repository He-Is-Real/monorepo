import type { Surreal, SurrealSession } from 'surrealdb';

/** SurrealDB refused the person's token (expired, wrong key, unknown or erased person). */
export class PersonSessionRefusedError extends Error {
  constructor(cause: unknown) {
    super(
      `SurrealDB refused the person's token: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'PersonSessionRefusedError';
  }
}

/**
 * Runs `work` in a SurrealDB session **as the person** (D27), on the service's one long-lived
 * connection: the pattern proven in integration/request-sessions.int-spec.ts.
 *
 * - `newSession()`, never `forkSession()`: a fresh session has no identity, while a fork
 *   inherits the service login and keeps it if the person's token is rejected.
 * - If SurrealDB rejects the token (`DEFINE ACCESS clerk`), this throws
 *   {@link PersonSessionRefusedError}. The token's ns/db claims select the database.
 * - Always `invalidate()` then `closeSession()`: surrealdb.js 2.0.8 otherwise leaks the
 *   session's token-renewal timer.
 * - The session lasts only as long as `token`: surrealdb.js 2.0.8 can't renew a token given to
 *   `authenticate()`, so at its `exp` (60 s before, for one with over two minutes left) it
 *   invalidates the session, even mid-query (#164). Pass a token that outlasts `work`:
 *   `PersonSessions` (`libs/consent`) gets a fresh one from Clerk when the person's runs short.
 */
export async function withPersonSession<T>(
  connection: Surreal,
  token: string,
  work: (session: SurrealSession) => Promise<T>,
): Promise<T> {
  const session = await connection.newSession();
  try {
    try {
      await session.authenticate(token);
    } catch (err) {
      throw new PersonSessionRefusedError(err);
    }
    return await work(session);
  } finally {
    await session.invalidate().catch(() => undefined);
    await session.closeSession().catch(() => undefined);
  }
}
