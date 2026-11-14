import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { DatabaseAvailability, SURREAL } from '@heisreal/database';
import type { Request } from 'express';
import type { Surreal } from 'surrealdb';
import { CLERK_CONFIG, type ClerkConfig } from './clerk-config';
import {
  ClerkTokenError,
  type VerifiedClerkToken,
  verifyClerkToken,
} from './clerk-token';
import {
  BlockedEmailError,
  ErasedIdentityError,
  findPerson,
  provisionPerson,
} from './people';
import type { AuthenticatedPerson, PersonAuthenticator } from './person';

/**
 * The request's Clerk session token, from `Authorization: Bearer …` only. The browser calls
 * the APIs cross-origin with `getToken()` (D31), so there's no cookie to read.
 */
export function bearerToken(request: Request): string {
  const header = request.headers?.authorization;
  const match =
    typeof header === 'string' ? /^Bearer ([^\s]+)$/.exec(header) : null;
  if (!match) throw new UnauthorizedException('Not signed in');
  return match[1];
}

/**
 * Users known to have a `user` row, so a busy person doesn't cost a lookup per request. Safe
 * to cache: if the row is erased meanwhile, SurrealDB refuses the person's session (its
 * AUTHENTICATE needs a live row), which answers 401.
 */
class KnownPeople {
  private readonly seen = new Map<string, number>();
  constructor(
    private readonly ttlMs = 5 * 60_000,
    private readonly max = 10_000,
  ) {}
  has(clerkUserId: string): boolean {
    const at = this.seen.get(clerkUserId);
    if (at === undefined) return false;
    if (Date.now() - at > this.ttlMs) {
      this.seen.delete(clerkUserId);
      return false;
    }
    return true;
  }
  add(clerkUserId: string): void {
    if (this.seen.size >= this.max) this.seen.clear();
    this.seen.set(clerkUserId, Date.now());
  }
}

/**
 * The real `PersonAuthenticator` (task 0.5): verifies the Clerk session token (no network,
 * `verifyClerkToken`), then makes sure the database knows the person, then returns the token
 * so personal queries run in the person's own SurrealDB session (D27). Every failure is a
 * refusal: 401 for anything wrong with the token, and the database error (500) if the row
 * check fails.
 */
abstract class ClerkAuthenticator implements PersonAuthenticator {
  protected readonly logger = new Logger(this.constructor.name);
  private readonly known = new KnownPeople();

  constructor(
    @Inject(CLERK_CONFIG) private readonly config: ClerkConfig,
    @Inject(SURREAL) protected readonly db: Surreal,
    @Optional() private readonly database?: DatabaseAvailability,
  ) {}

  async authenticate(request: Request): Promise<AuthenticatedPerson> {
    const token = bearerToken(request);
    let verified: VerifiedClerkToken;
    try {
      verified = verifyClerkToken(token, this.config, this.config.clock?.());
    } catch (err) {
      const reason = err instanceof ClerkTokenError ? err.reason : 'error';
      this.logger.warn(`Refused a session token: ${reason}`);
      throw new UnauthorizedException('The session token was refused');
    }
    if (!this.known.has(verified.clerkUserId)) {
      // Guards run before DatabaseAvailabilityInterceptor: a lookup during an outage, or one
      // still waiting when it starts, answers `503 service_restarting` at once rather than wait
      // minutes for a restarting database. Either way the request is refused, never let through.
      const { clerkUserId, email } = verified;
      await (this.database
        ? this.database.whileAvailable(() =>
            this.ensurePerson(clerkUserId, email),
          )
        : this.ensurePerson(clerkUserId, email));
      this.known.add(verified.clerkUserId);
    }
    return {
      clerkUserId: verified.clerkUserId,
      token: verified.token,
      role: verified.role,
      sessionId: verified.sessionId,
      expiresAt: verified.expiresAt,
      email: verified.email,
    };
  }

  /** Makes sure the `user` row exists, or refuses. `email`: the token's verified email, if any. */
  protected abstract ensurePerson(
    clerkUserId: string,
    email?: string,
  ): Promise<void>;
}

/**
 * api-user: creates the person's `user` row on first use, on api-user's own login (the only
 * identity the schema lets create users; D13). The row holds only `clerkUserId` (D16). A blocked
 * email (block list, G21 D) gets no row: `403 blocked`, which the site shows only as its generic
 * "Something went wrong" (Joel, 2026-11-09).
 */
@Injectable()
export class ApiUserAuthenticator extends ClerkAuthenticator {
  protected async ensurePerson(
    clerkUserId: string,
    email?: string,
  ): Promise<void> {
    try {
      await provisionPerson(this.db, clerkUserId, { email });
    } catch (err) {
      if (err instanceof BlockedEmailError) {
        this.logger.warn('Refused a new account: its email is blocked');
        throw new ForbiddenException({
          code: 'blocked',
          message: 'This account can’t be used',
        });
      }
      // D82: the account was deleted; its leftover token (or Clerk account) is refused.
      if (err instanceof ErasedIdentityError) {
        this.logger.warn('Refused a session token: the account was erased');
        throw new UnauthorizedException('The session token was refused');
      }
      throw err;
    }
  }
}

/**
 * api-admin: its login can read users but not create them (D13), so a staff member must
 * already have a row, made by their first api-user request (or a D22 legacy link). Unknown
 * people get 403 `unknown_person`. Staff need the row anyway: it's the `by` of a moderator's status
 * entry, the `changedBy` of a setting and the `publishedBy` of a legal text (db-permissions.md).
 */
@Injectable()
export class ApiAdminAuthenticator extends ClerkAuthenticator {
  protected async ensurePerson(clerkUserId: string): Promise<void> {
    if (!(await findPerson(this.db, clerkUserId))) {
      throw new ForbiddenException({
        code: 'unknown_person',
        message:
          'Not known to the database yet: sign in to the site once, then try again',
      });
    }
  }
}
