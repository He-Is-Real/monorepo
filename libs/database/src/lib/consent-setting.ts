import { withTimeout } from '@heisreal/secrets';
import type { SurrealQueryable } from 'surrealdb';
import { runQuery } from './query';

/**
 * D48: whether the database relaxes consent checks for dummy data (dev only). The database's own
 * switch (`_setting:consent`, written by the migration from OpenTofu's dev-only variable), read
 * through the same function every consent check uses, so services never keep a copy of their
 * own. `undefined` when the database can't say (unreachable, or a schema without D48).
 */
export async function readConsentRelaxed(
  db: SurrealQueryable,
  timeoutMs = 2000, // as the health check: queries wait indefinitely while reconnecting
): Promise<boolean | undefined> {
  try {
    const [relaxed] = await withTimeout(
      runQuery(db, 'RETURN fn::consent::relaxed()'),
      timeoutMs,
      'Consent setting',
    );
    return relaxed === true;
  } catch {
    return undefined;
  }
}
