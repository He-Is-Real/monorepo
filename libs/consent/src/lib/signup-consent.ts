import { Injectable } from '@nestjs/common';
import type { PersonContext } from './person';

/**
 * Whether the signed-in person has accepted the latest published sign-up consent form (D73,
 * D84: a simple, versioned form; every newly published version must be accepted before the
 * site can be used signed in). api-user's account bootstrap (`GET /v1/account`) reports it as
 * `signupConsent.accepted`, so web can show the one-time sign-up step.
 *
 * **Seam for the consent-forms PR (M2, "consent forms"):** it adds the `signupFormVersion`
 * table and the person's acceptance of a version, and replaces {@link NoSignupFormPublished}
 * below with the real check, read in the person's own session (D27). Nothing else changes.
 */
export interface SignupConsentStatus {
  /** True only if the person has accepted the newest published sign-up form version. */
  acceptedLatest(person: PersonContext): Promise<boolean>;
}

export const SIGNUP_CONSENT_STATUS = Symbol('SIGNUP_CONSENT_STATUS');

/**
 * Until the consent-forms PR: the schema has no sign-up form, so none is published and nobody
 * can have accepted the latest one. That is the true answer today, not a stand-in: `false`
 * for everyone (fail closed), and nothing acts on it until the sign-up step is built.
 */
@Injectable()
export class NoSignupFormPublished implements SignupConsentStatus {
  async acceptedLatest(): Promise<boolean> {
    return false;
  }
}
