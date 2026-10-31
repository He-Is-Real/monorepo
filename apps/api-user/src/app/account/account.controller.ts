import {
  Controller,
  Delete,
  Get,
  Headers,
  HttpStatus,
  Inject,
  Module,
  Req,
  Res,
} from '@nestjs/common';
import {
  ifNoneMatches,
  NoConsentRequired,
  PersonSessions,
  SIGNUP_CONSENT_STATUS,
  type SignupConsentStatus,
  weakETag,
} from '@heisreal/consent';
import { runQuery } from '@heisreal/database';
import { RequiresRole } from '@heisreal/roles';
import type { Request, Response } from 'express';
import { Erasure } from '../erasure/erasure';

/** The contract's `Account` (components.yaml). */
export interface Account {
  id: string;
  version: null;
  role: string;
  createdAt: string;
  signupConsent: { accepted: boolean };
  testimonyConsent: { acceptanceRequired: boolean };
}

/**
 * The account bootstrap (M2, `GET /v1/account`): web's header calls it once each time a page
 * loads signed in. Built from the verified Clerk token and the database only, never Clerk's
 * Backend API (no secret key, no network). The authenticator has already created the person's
 * `user` row on api-user's login if this is their first call (D13), which is also what lets
 * staff use api-admin; the row is then read in the person's own session (D27).
 */
@Controller('v1/account')
export class AccountController {
  constructor(
    private readonly people: PersonSessions,
    @Inject(SIGNUP_CONSENT_STATUS)
    private readonly signupConsent: SignupConsentStatus,
    private readonly erasure: Erasure,
  ) {}

  @Get()
  @RequiresRole('User')
  @NoConsentRequired(
    'the account bootstrap tells the site whether the sign-up form still needs accepting (D73)',
  )
  async getAccount(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers('if-none-match') ifNoneMatch?: string,
  ): Promise<Account | undefined> {
    const { role } = await this.people.authenticate(req);
    const account = await this.people.run(req, async (person) => {
      const [user] = (await runQuery(
        person.session,
        'SELECT <string> record::id(id) AS id, createdAt FROM ONLY $auth',
      )) as [{ id: string; createdAt: string } | undefined];
      // The session opened as this person, so their row exists; checked anyway, fail closed.
      if (!user) throw new Error('The signed-in person’s user row is missing');
      return {
        id: user.id,
        version: null,
        // The RoleGuard has checked it is a role, at least User (D1).
        role: role as string,
        createdAt: new Date(user.createdAt).toISOString(),
        signupConsent: {
          accepted: await this.signupConsent.acceptedLatest(person),
        },
        // D85: the signed-in banner. The database's own answer (fn::consent::testimony_status),
        // the one the new-draft and submit gates use.
        testimonyConsent: {
          acceptanceRequired: await testimonyAcceptanceRequired(person.session),
        },
      } satisfies Account;
    });
    const etag = weakETag(account);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('ETag', etag);
    if (ifNoneMatches(ifNoneMatch, etag)) {
      res.status(HttpStatus.NOT_MODIFIED);
      return undefined;
    }
    return account;
  }

  /**
   * "Delete my account" (D39, D82; the profile's Your data): erases the person on api-user's own
   * login (their session can't delete stories), then deletes their media at Bunny and their Clerk
   * account. Answers 202 once the database half has committed; a Bunny or Clerk deletion that
   * fails is retried later (D40). No `If-Match` or `Idempotency-Key` (a listed exception, D29):
   * it can only happen once, and a repeat finds nothing to erase.
   */
  @Delete()
  @RequiresRole('User')
  @NoConsentRequired(
    'deleting your account needs no consent (your right to erasure, Art 17)',
  )
  async eraseAccount(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const { clerkUserId } = await this.people.authenticate(req);
    // Only a live person: their own session must open, so a leftover token of an account that's
    // already gone gets 401, like every other route.
    await this.people.run(req, async () => undefined);
    await this.erasure.erase(clerkUserId, 'account_deleted');
    res.status(HttpStatus.ACCEPTED);
  }
}

/**
 * D85, D93: a testimony form version requiring acceptance for new submissions came after the
 * person's own (their current Art 9 grant's form), so they must accept the one in force before
 * a new draft or a submission. Read in their own session (D27).
 */
async function testimonyAcceptanceRequired(
  session: Parameters<typeof runQuery>[0],
): Promise<boolean> {
  const [status] = (await runQuery(
    session,
    'RETURN fn::consent::testimony_status($auth)',
  )) as [{ acceptanceRequired?: boolean } | undefined];
  return status?.acceptanceRequired === true;
}

@Module({ controllers: [AccountController] })
export class AccountModule {}
