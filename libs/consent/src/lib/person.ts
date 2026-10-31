import {
  Inject,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  PersonSessionRefusedError,
  SURREAL,
  withPersonSession,
} from '@heisreal/database';
import type { Request } from 'express';
import type { RecordId, Surreal, SurrealSession } from 'surrealdb';

/**
 * The seam with sign-in. Everything personal in this library starts from an
 * `AuthenticatedPerson`; nothing here verifies a Clerk token itself.
 *
 * `libs/auth` (task 0.5) provides the `PersonAuthenticator`s that verify the request's Clerk
 * session token (signature, `exp`/`nbf`, `iss`, and `azp`, which SurrealDB doesn't check;
 * docs/db-permissions.md, "Clerk side"), passed in with `ConsentModule.forRoot({ authenticator })`.
 * They also make sure the person's `user` row exists (api-user's login creates it on first
 * use), since SurrealDB's `DEFINE ACCESS clerk` only signs in people it knows.
 */
export interface AuthenticatedPerson {
  /** The verified Clerk user id (`sub`). */
  readonly clerkUserId: string;
  /** The verified Clerk session token; opens the person's SurrealDB session (D27). */
  readonly token: string;
  /**
   * The verified role claim (D1), one of `@heisreal/auth`'s `ROLES`. Absent means no role:
   * every role check refuses.
   */
  readonly role?: string;
  /** The verified Clerk session id (`sid`): a fresh pass is asked for this session only. */
  readonly sessionId?: string;
  /** When `token` expires (`exp`, seconds since the epoch). */
  readonly expiresAt?: number;
}

export interface PersonAuthenticator {
  /** Throws `UnauthorizedException` (401) when credentials are missing or invalid. */
  authenticate(request: Request): Promise<AuthenticatedPerson>;
}

export const PERSON_AUTHENTICATOR = Symbol('PERSON_AUTHENTICATOR');

/**
 * The default when no authenticator is given: nobody can sign in, so every personal route
 * answers `401` (fail closed). api-user and api-admin pass `libs/auth`'s Clerk authenticators.
 */
export class SignInUnavailable implements PersonAuthenticator {
  async authenticate(): Promise<AuthenticatedPerson> {
    throw new UnauthorizedException('Sign-in is not available on this service');
  }
}

/**
 * The two kinds of a person's work (one `PersonSessions.run`; decision T, option B).
 * surrealdb.js 2.0.8 ends a session it can't renew when its token expires, even mid-query (#164),
 * and a browser's Clerk token arrives with 10 to 60 s left, so each kind says how long its
 * session must still last when it opens (`sessionSeconds`), and for how long the work may start
 * new attempts (`retrySeconds`; {@link PersonContext.deadline}).
 * - `quick`: database work only, whose retries wait milliseconds (most routes, and the consent
 *   guard). The person's own pass while it lasts 10 s more, else a fresh one.
 * - `slow`: work that waits on Bunny or reads everything a person has (submit, an upload link,
 *   the data download). Always a fresh pass, never a guess from the time left: no attempt starts
 *   after two minutes, and the last one (a Bunny call or two at their 15 s timeout, plus the
 *   database) has two more before the session's end.
 */
export const PERSON_WORK = {
  quick: { sessionSeconds: 10, retrySeconds: 5 },
  slow: { sessionSeconds: 240, retrySeconds: 120 },
} as const;
export type PersonWork = keyof typeof PERSON_WORK;

/**
 * How long Clerk is asked to make a fresh pass last. surrealdb.js 2.0.8 ends a session 60 s
 * before its token's `exp` once the token has over two minutes left (its `expiryMargin`), so six
 * minutes give a session of five, the database's own (`DURATION FOR SESSION 5m`,
 * access-clerk.surql). Cloud Run's timeout ends only the response, not our work: the slow work's
 * deadline is what stops it well inside those five minutes.
 */
export const FRESH_PASS_SECONDS = 360;

/** The SDK's `expiryMargin` (surrealdb.js 2.0.8 default; libs/database doesn't change it). */
const SDK_EXPIRY_MARGIN = 60;

/**
 * How long surrealdb.js 2.0.8 keeps a session authenticated with a token that has `remaining`
 * seconds left: until `exp` for a token with up to a minute left, a minute for one with up to
 * two, and `exp` less a minute beyond that (its renewal timer, which can only end the session).
 */
export function sessionSecondsLeft(remaining: number): number {
  if (remaining <= SDK_EXPIRY_MARGIN) return Math.max(remaining, 0);
  return Math.max(remaining - SDK_EXPIRY_MARGIN, SDK_EXPIRY_MARGIN);
}

/**
 * Issues a fresh session token for a person's own, still-live Clerk session (api-user, with
 * Clerk's Backend API; decision T, option B). The token never leaves the server: it only opens
 * the person's database session, so the database still does the work as them (D27).
 */
export interface PersonPassIssuer {
  /**
   * A token for `sessionId` of `clerkUserId`, lasting `seconds`. Throws
   * {@link PersonPassRefusedError} if Clerk says the session is over (signed out, revoked,
   * blocked or deleted); anything else thrown means Clerk couldn't answer.
   */
  issue(
    clerkUserId: string,
    sessionId: string,
    seconds: number,
  ): Promise<string>;
}

export const PERSON_PASS_ISSUER = Symbol('PERSON_PASS_ISSUER');

/** Clerk refused a fresh pass: the person's session is over, so they're signed out. */
export class PersonPassRefusedError extends Error {
  constructor(reason: string) {
    super(`Clerk refused a fresh pass: ${reason}`);
    this.name = 'PersonPassRefusedError';
  }
}

interface Pass {
  token: string;
  expiresAt: number;
}

/** A person's database session for one request, and who they are in the database. */
export interface PersonContext {
  session: SurrealSession;
  /** Their `user` record (`$auth`). */
  user: RecordId;
  /**
   * When the work must stop starting new attempts (ms since the epoch), so it ends inside the
   * session: pass it to `runIdempotent`, which then throws its last retryable error instead.
   */
  deadline: number;
}

/**
 * Runs work as the signed-in person (D27): authenticates the request once (cached per request,
 * so the guard and the handler don't verify twice), then opens a fresh session on the
 * service's connection for each unit of work.
 */
@Injectable()
export class PersonSessions {
  private readonly logger = new Logger(PersonSessions.name);
  private readonly verified = new WeakMap<
    Request,
    Promise<AuthenticatedPerson>
  >();
  /** Fresh passes, per verified person (so per request): later units reuse one. */
  private readonly fresh = new WeakMap<AuthenticatedPerson, Promise<Pass>>();
  private warnedNoIssuer = false;

  constructor(
    @Inject(SURREAL) private readonly connection: Surreal,
    @Inject(PERSON_AUTHENTICATOR)
    private readonly authenticator: PersonAuthenticator,
    @Optional()
    @Inject(PERSON_PASS_ISSUER)
    private readonly issuer: PersonPassIssuer | null = null,
  ) {}

  authenticate(request: Request): Promise<AuthenticatedPerson> {
    let person = this.verified.get(request);
    if (!person) {
      person = this.authenticator.authenticate(request);
      this.verified.set(request, person);
    }
    return person;
  }

  /** `kind`: {@link PERSON_WORK}; `slow` for anything that waits on Bunny or reads a lot. */
  async run<T>(
    request: Request,
    work: (person: PersonContext) => Promise<T>,
    kind: PersonWork = 'quick',
  ): Promise<T> {
    const person = await this.authenticate(request);
    return this.runAs(person, work, kind);
  }

  async runAs<T>(
    person: AuthenticatedPerson,
    work: (person: PersonContext) => Promise<T>,
    kind: PersonWork = 'quick',
  ): Promise<T> {
    const token = await this.passFor(person, kind);
    const deadline = Date.now() + PERSON_WORK[kind].retrySeconds * 1000;
    return withPersonSession(this.connection, token, async (session) => {
      const [user] = (await session.query('RETURN $auth').collect()) as [
        RecordId | undefined,
      ];
      // A valid token for someone the database doesn't know (or has erased) can't get here:
      // AUTHENTICATE refuses it. Checked anyway, fail closed.
      if (!user) throw new UnauthorizedException('Not signed in');
      return work({ session, user, deadline });
    }).catch((err: unknown) => {
      if (err instanceof PersonSessionRefusedError) {
        throw new UnauthorizedException('The session token was refused');
      }
      throw err;
    });
  }

  /**
   * The token to open the person's session with: for quick work theirs while it lasts long
   * enough, else (and always for slow work) a fresh pass for the same Clerk session (decision T,
   * option B), one per request while it lasts long enough. The caller's token was
   * verified first (signature, `exp`, `iss`, `azp`), which is what proves the session is theirs.
   * Clerk refusing means signed out (401); Clerk not answering fails the request (503, try
   * again), never a silent fall back to a token that can't cover the work.
   */
  private async passFor(
    person: AuthenticatedPerson,
    kind: PersonWork,
  ): Promise<string> {
    const { sessionSeconds } = PERSON_WORK[kind];
    const enough = (pass: Pass) =>
      sessionSecondsLeft(pass.expiresAt - Date.now() / 1000) >= sessionSeconds;
    if (person.expiresAt === undefined) return person.token;
    if (
      kind === 'quick' &&
      enough({ token: person.token, expiresAt: person.expiresAt })
    ) {
      return person.token;
    }
    const issuer = this.issuer;
    if (!issuer) {
      // api-admin (no Clerk key, D81), or api-user before its key is set.
      if (!this.warnedNoIssuer) {
        this.warnedNoIssuer = true;
        this.logger.warn(
          'A person’s pass may run out during their request, and this service can’t ask Clerk for a fresh one: their own pass is used',
        );
      }
      return person.token;
    }
    const sessionId = person.sessionId;
    if (!sessionId) throw new UnauthorizedException('Not signed in');
    const earlier = await this.fresh.get(person)?.catch(() => undefined);
    if (earlier && enough(earlier)) return earlier.token;
    const pending = this.issue(issuer, person.clerkUserId, sessionId);
    this.fresh.set(person, pending);
    const pass = await pending.catch((err: unknown) => {
      if (this.fresh.get(person) === pending) this.fresh.delete(person);
      throw err;
    });
    if (!enough(pass)) throw signInUnavailable();
    return pass.token;
  }

  private async issue(
    issuer: PersonPassIssuer,
    clerkUserId: string,
    sessionId: string,
  ): Promise<Pass> {
    let token: string;
    try {
      token = await issuer.issue(clerkUserId, sessionId, FRESH_PASS_SECONDS);
    } catch (err) {
      if (err instanceof PersonPassRefusedError) {
        throw new UnauthorizedException('The session has ended');
      }
      // The issuer's messages name a status or a timeout at most: never a token, key or person.
      this.logger.warn(
        `Clerk couldn’t issue a fresh pass: ${err instanceof Error ? err.message : 'error'}`,
      );
      throw signInUnavailable();
    }
    // Timed by the `exp` Clerk wrote (the database checks its signature when it opens the
    // session); a pass without one is no use.
    const expiresAt = expiryOf(token);
    if (expiresAt === undefined) throw signInUnavailable();
    return { token, expiresAt };
  }
}

const signInUnavailable = () =>
  new ServiceUnavailableException({
    code: 'sign_in_unavailable',
    message: 'We couldn’t confirm you’re signed in just now. Please try again.',
  });

/** A JWT's `exp`, read without verifying it (only for timing). */
function expiryOf(token: string): number | undefined {
  try {
    const claims = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
    ) as { exp?: unknown };
    return typeof claims.exp === 'number' && Number.isFinite(claims.exp)
      ? claims.exp
      : undefined;
  } catch {
    return undefined;
  }
}
