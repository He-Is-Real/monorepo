import { Inject, Injectable } from '@nestjs/common';
import { runQuery, SURREAL } from '@heisreal/database';
import type { Surreal, SurrealQueryable } from 'surrealdb';
import type { ConsentType } from './consent.types';

/**
 * Answers "is this consent currently granted?" with the database's own definition,
 * `fn::consent::granted` (latest ledger event per type through the consent_latest index;
 * D17, D18). Nothing is cached: every call reads the ledger at that moment.
 *
 * `fn::consent::granted` runs with the caller's permissions, so whoever can't read the
 * person's ledger gets `false`: fail closed.
 */
@Injectable()
export class ConsentChecker {
  constructor(@Inject(SURREAL) private readonly service: Surreal) {}

  /** The signed-in person's own consent, in their own session (D27). */
  async callerHas(
    personSession: SurrealQueryable,
    types: readonly ConsentType[],
  ): Promise<boolean> {
    const [granted] = await runQuery(
      personSession,
      'RETURN fn::consent::granted($auth, $types)',
      { types: [...types] },
    );
    return granted === true;
  }

  /**
   * The consent of a story's submitter, on the service's own login. Only api-admin's login
   * (and workflow's) can read stories and the ledger; on api-user's it is always `false`.
   * An unknown story has no submitter, so it is `false` too.
   */
  async submitterHas(
    storyId: string,
    types: readonly ConsentType[],
  ): Promise<boolean> {
    const results = await runQuery(
      this.service,
      `LET $story = type::record('story', $id);
       RETURN fn::consent::granted($story.submitter, $types);`,
      { id: storyId, types: [...types] },
    );
    return results[results.length - 1] === true;
  }
}
