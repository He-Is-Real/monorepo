import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Module,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { PersonSessions } from '@heisreal/auth';
import { runQuery } from '@heisreal/database';
import { ifNoneMatches, ProblemException, weakETag } from '@heisreal/http';
import { RequiresRole } from '@heisreal/roles';
import type { Request, Response } from 'express';
import { Erasure } from '../erasure/erasure';
import {
  agree,
  type Agreements,
  type AgreementState,
  isAgreementName,
  readAgreements,
} from './agreements';

/** The contract's `Account` (components.yaml). */
export interface Account extends Agreements {
  id: string;
  version: null;
  role: string;
  createdAt: string;
}

const invalid = (pointer: string, message: string) =>
  new ProblemException(
    HttpStatus.BAD_REQUEST,
    'validation_failed',
    'Validation failed',
    undefined,
    [{ pointer, message }],
  );

/** `Agree`'s body: `{ version }`, a version number (0, 1, 2...). */
function parseAgree(body: unknown): number {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalid('', 'a JSON object');
  }
  const b = body as Record<string, unknown>;
  const unknown = Object.keys(b).find((k) => k !== 'version');
  if (unknown) throw invalid(`/${unknown}`, 'not a field of this command');
  const version = b['version'];
  if (!(
    typeof version === 'number' &&
    Number.isInteger(version) &&
    version >= 0
  )) {
    throw invalid('/version', 'the version number the page showed');
  }
  return version;
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
    private readonly erasure: Erasure,
  ) {}

  @Get()
  @RequiresRole('User')
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
        // Plan 4e: whether the person must agree to the terms of use before using the account,
        // and to the testimony consent before their next story (the database's own pointers).
        ...(await readAgreements(person.session)),
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
   * Command `Agree` (plan 4e): the person agrees to the latest version of the terms of use or
   * the testimony consent, the version the page showed, in their own session (D27). Idempotent;
   * an older version is `409 agreement_version_changed`. No `If-Match` or `Idempotency-Key` (a
   * listed exception to D29).
   */
  @Post('agreements/:agreement')
  @HttpCode(HttpStatus.OK)
  @RequiresRole('User')
  async agree(
    @Req() req: Request,
    @Param('agreement') agreement: string,
    @Body() body: unknown,
  ): Promise<AgreementState> {
    if (!isAgreementName(agreement)) {
      throw invalid('/agreement', 'terms-of-use or testimony-consent');
    }
    const version = parseAgree(body);
    return this.people.run(req, ({ session }) =>
      agree(session, agreement, version),
    );
  }

  /**
   * "Delete my account" (D39, D82; the profile's Your data): erases the person on api-user's own
   * login (their session can't delete stories), then deletes their media at Bunny and their Clerk
   * account. Answers 202 once the database half has committed; a Bunny or Clerk deletion that
   * fails is retried later (D40). No `If-Match` or `Idempotency-Key` (a listed exception, D29):
   * it can only happen once, and a repeat finds nothing to erase. It is also how a person
   * withdraws all consent (plan 4e): their agreements go with the account.
   */
  @Delete()
  @RequiresRole('User')
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

@Module({ controllers: [AccountController] })
export class AccountModule {}
