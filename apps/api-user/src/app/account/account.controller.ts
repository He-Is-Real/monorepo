import {
  Controller,
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
