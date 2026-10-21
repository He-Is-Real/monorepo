import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type {
  AuthenticatedPerson,
  PersonAuthenticator,
} from '@heisreal/consent';
import { SURREAL } from '@heisreal/database';
import type { Request } from 'express';
import type { Surreal } from 'surrealdb';
import { CLERK_CONFIG, type ClerkConfig } from './clerk-config';
import {
  ClerkTokenError,
  type VerifiedClerkToken,
  verifyClerkToken,
} from './clerk-token';
import { findPerson, provisionPerson } from './people';

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
  ) {}

  async authenticate(request: Request): Promise<AuthenticatedPerson> {
    const token = bearerToken(request);
    let verified: VerifiedClerkToken;
    try {
      verified = verifyClerkToken(token, this.config);
    } catch (err) {
      const reason = err instanceof ClerkTokenError ? err.reason : 'error';
      this.logger.warn(`Refused a session token: ${reason}`);
      throw new UnauthorizedException('The session token was refused');
    }
    if (!this.known.has(verified.clerkUserId)) {
      await this.ensurePerson(verified.clerkUserId);
      this.known.add(verified.clerkUserId);
    }
    return {
      clerkUserId: verified.clerkUserId,
      token: verified.token,
      role: verified.role,
    };
  }

  /** Makes sure the `user` row exists, or refuses. */
  protected abstract ensurePerson(clerkUserId: string): Promise<void>;
}

/**
 * api-user: creates the person's `user` row on first use, on api-user's own login (the only
 * identity the schema lets create users; D13). The row holds only `clerkUserId` (D16).
 */
@Injectable()
export class ApiUserAuthenticator extends ClerkAuthenticator {
  protected async ensurePerson(clerkUserId: string): Promise<void> {
    await provisionPerson(this.db, clerkUserId);
  }
}

/**
 * api-admin: its login can read users but not create them (D13), so a staff member must
 * already have a row, made by their first api-user request (or a D22 legacy link). Unknown
 * people get 403 `unknown_person`. Staff need the row anyway: it's the `moderator` of a review
 * and the `actor` of an audit row (db-permissions.md, item 14).
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
