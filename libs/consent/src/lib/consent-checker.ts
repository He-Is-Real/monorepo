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

  /**
   * The signed-in person's own consent, in their own session (D27). `formsInForce`: also on the
   * forms in force, for something new (a draft, a submission; D93, `fn::consent::may_draft`).
   */
  async callerHas(
    personSession: SurrealQueryable,
    types: readonly ConsentType[],
    formsInForce = false,
  ): Promise<boolean> {
    const [granted] = await runQuery(
      personSession,
      'RETURN fn::consent::granted($auth, $types) AND (!$forms OR fn::consent::may_draft($auth))',
      { types: [...types], forms: formsInForce },
    );
    return granted === true;
  }

  /**
   * D73: whether the signed-in person has accepted the sign-up form in force (both boxes, on
   * its latest version), in their own session. Sign-in (api-user's account bootstrap) asks for
   * it; a newer sign-up version makes it false again (nothing already public changes, D93).
   */
  async callerAcceptedSignup(
    personSession: SurrealQueryable,
  ): Promise<boolean> {
    const [accepted] = await runQuery(
      personSession,
      'RETURN fn::consent::signup_accepted($auth)',
    );
    return accepted === true;
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
