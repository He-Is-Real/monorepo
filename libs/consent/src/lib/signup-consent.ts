import { Injectable } from '@nestjs/common';
import { runQuery } from '@heisreal/database';
import type { PersonContext } from './person';

/**
 * Whether the signed-in person has accepted the latest published sign-up consent form (D73,
 * D84: a simple, versioned form; every newly published version must be accepted before the
 * site can be used signed in). api-user's account bootstrap (`GET /v1/account`) reports it as
 * `signupConsent.accepted`, so web can show the one-time sign-up step.
 */
export interface SignupConsentStatus {
  /** True only if the person has accepted the newest published sign-up form version. */
  acceptedLatest(person: PersonContext): Promise<boolean>;
}

export const SIGNUP_CONSENT_STATUS = Symbol('SIGNUP_CONSENT_STATUS');

/**
 * The database's answer, `fn::consent::signup_accepted`, read in the person's own session
 * (D27): both of the sign-up form's boxes (18+ and `account_data`) granted on the version in
 * force. `false` while no sign-up form is published (fail closed). A new sign-up version makes
 * it `false` again until it's accepted; nothing already public changes (D93).
 */
@Injectable()
export class LedgerSignupConsentStatus implements SignupConsentStatus {
  async acceptedLatest({ session }: PersonContext): Promise<boolean> {
    const [accepted] = await runQuery(
      session,
      'RETURN fn::consent::signup_accepted($auth)',
    );
    return accepted === true;
  }
}
