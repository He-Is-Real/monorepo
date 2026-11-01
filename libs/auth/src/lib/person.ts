import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import {
  PersonSessionRefusedError,
  SURREAL,
  withPersonSession,
} from '@heisreal/database';
import type { Request } from 'express';
import type { RecordId, Surreal, SurrealSession } from 'surrealdb';

/**
 * The seam with sign-in. Everything personal in the services starts from an
 * `AuthenticatedPerson`; `PersonSessions` doesn't verify a Clerk token itself.
 *
 * The `PersonAuthenticator`s (clerk-authenticator.ts, task 0.5) verify the request's Clerk
 * session token (signature, `exp`/`nbf`, `iss`, and `azp`, which SurrealDB doesn't check;
 * docs/db-permissions.md, "Clerk side"), passed in with `ClerkAuthModule.forRoot({ authenticator })`.
 * They also make sure the person's `user` row exists (api-user's login creates it on first
 * use), since SurrealDB's `DEFINE ACCESS clerk` only signs in people it knows.
 */
export interface AuthenticatedPerson {
  /** The verified Clerk user id (`sub`). */
  readonly clerkUserId: string;
  /** The verified Clerk session token; opens the person's SurrealDB session (D27). */
  readonly token: string;
  /**
   * The verified role claim (D1), one of `@heisreal/roles`' `ROLES`. Absent means no role:
   * every role check refuses.
   */
  readonly role?: string;
}

export interface PersonAuthenticator {
  /** Throws `UnauthorizedException` (401) when credentials are missing or invalid. */
  authenticate(request: Request): Promise<AuthenticatedPerson>;
}

export const PERSON_AUTHENTICATOR = Symbol('PERSON_AUTHENTICATOR');

/**
 * The default when no authenticator is given: nobody can sign in, so every personal route
 * answers `401` (fail closed). api-user and api-admin pass their Clerk authenticators.
 */
export class SignInUnavailable implements PersonAuthenticator {
  async authenticate(): Promise<AuthenticatedPerson> {
    throw new UnauthorizedException('Sign-in is not available on this service');
  }
}

/** A person's database session for one request, and who they are in the database. */
export interface PersonContext {
  session: SurrealSession;
  /** Their `user` record (`$auth`). */
  user: RecordId;
}

/**
 * Runs work as the signed-in person (D27): authenticates the request once (cached per request,
 * so the role guard and the handler don't verify twice), then opens a fresh session on the
 * service's connection for each unit of work.
 */
@Injectable()
export class PersonSessions {
  private readonly verified = new WeakMap<
    Request,
    Promise<AuthenticatedPerson>
  >();

  constructor(
    @Inject(SURREAL) private readonly connection: Surreal,
    @Inject(PERSON_AUTHENTICATOR)
    private readonly authenticator: PersonAuthenticator,
  ) {}

  authenticate(request: Request): Promise<AuthenticatedPerson> {
    let person = this.verified.get(request);
    if (!person) {
      person = this.authenticator.authenticate(request);
      this.verified.set(request, person);
    }
    return person;
  }

  async run<T>(
    request: Request,
    work: (person: PersonContext) => Promise<T>,
  ): Promise<T> {
    const person = await this.authenticate(request);
    return this.runAs(person, work);
  }

  runAs<T>(
    person: AuthenticatedPerson,
    work: (person: PersonContext) => Promise<T>,
  ): Promise<T> {
    return withPersonSession(this.connection, person.token, async (session) => {
      const [user] = (await session.query('RETURN $auth').collect()) as [
        RecordId | undefined,
      ];
      // A valid token for someone the database doesn't know (or has erased) can't get here:
      // AUTHENTICATE refuses it. Checked anyway, fail closed.
      if (!user) throw new UnauthorizedException('Not signed in');
      return work({ session, user });
    }).catch((err: unknown) => {
      if (err instanceof PersonSessionRefusedError) {
        throw new UnauthorizedException('The session token was refused');
      }
      throw err;
    });
  }
}
