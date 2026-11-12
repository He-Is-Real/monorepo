'use client';

/**
 * web's one client for api-user: **browser only** (D31, D32, D83). The browser calls api-user
 * directly with the person's Clerk session token; web's server never does, and never sees the
 * token. `'use client'` and the check in `apiUser()` keep it out of server code (a server
 * component can't call these functions), and apps/web/eslint.config.mjs lets only this file
 * build request headers and read response headers (the reviewed carve-out in D32's guardrail;
 * apps/web/README.md).
 *
 * - **A fresh token on every call:** `getToken()` (Clerk's, from `useAuth()`) is asked each
 *   time; Clerk caches and renews it (it lives 60 s). No token, no request ({@link NotSignedIn}).
 * - **Errors are RFC 9457 problems** (docs/api-conventions.md, D30): any answer that isn't 2xx
 *   or 304 throws an {@link ApiUserProblem} with the problem's `status`, `code`, `detail` and
 *   field `errors`. A network failure or timeout throws {@link ApiUserUnavailable}, and so does a
 *   success whose body can't be read or parsed: either way the outcome is unknown.
 * - **`503 service_restarting` means the database is restarting** (SurrealDB on Spot): it's
 *   thrown like any problem, so the caller keeps what the person typed, and reported to
 *   `RestartingNotice`, which says when to try again. The next successful answer clears it.
 * - **412 means the resource changed since it was read** ({@link StaleVersion}): re-read it,
 *   re-apply the change if nothing it touched has changed, and ask the person only on a real
 *   clash (D70). **428 means we forgot `If-Match`**, a bug in our code, never the person's.
 * - Commands that modify an existing resource send `If-Match` with its `version`
 *   ({@link ifMatch}); non-idempotent `POST`s send an `Idempotency-Key`
 *   ({@link newIdempotencyKey}), kept and reused when retrying the same command (D29).
 * - **api-admin too:** staff pages (`/admin/consent`) call api-admin with this same client at
 *   api-admin's origin (`API_ADMIN_URL`): the same token, the same rules (D31).
 */

import {
  clearRestarting,
  reportRestarting,
} from '@/components/restarting/restarting-message';
import { restartingSeconds } from './restarting';
import { TRY_AGAIN_LATER } from './try-again-later';

/** Clerk's `getToken()`: the current session token, or null when signed out. */
export type GetToken = () => Promise<string | null>;

/** The contract's `Problem` (libs/contracts/openapi/components.yaml). */
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  code?: string;
  errors?: { pointer: string; code?: string; message: string }[];
}

/** The contract's `Account`: the bootstrap `GET /v1/account` answers. */
export interface Account {
  id: string;
  version: null;
  role: 'Viewer' | 'User' | 'Moderator' | 'Admin';
  createdAt: string;
  /** Plan 4e: the terms of use, agreed before the account can be used (they say 18 or over). */
  termsOfUse: AgreementState;
  /** Plan 4e: the testimony consent, agreed before the first story and again for a newer one. */
  testimonyConsent: AgreementState;
}

/** The contract's `Agreement`: a version someone agreed to, and when (the database's time). */
export interface Agreement {
  version: number;
  agreedAt: string;
}

/**
 * The contract's `AgreementState`: `agreed` is null until the first agreement; `upToDate` is
 * whether that's the latest version.
 */
export interface AgreementState {
  agreed: Agreement | null;
  latestVersion: number;
  upToDate: boolean;
}

/** api-user answered with an error (anything but 2xx and 304). */
export class ApiUserProblem extends Error {
  /**
   * `restartingSeconds`: set on a `503 service_restarting` (the database is restarting): when to
   * try again, from `retryAfterSeconds` or `Retry-After`.
   */
  constructor(
    readonly problem: Problem,
    readonly restartingSeconds?: number,
  ) {
    super(
      `api-user answered ${problem.status}${problem.code ? ` ${problem.code}` : ''}`,
    );
    this.name = 'ApiUserProblem';
  }
  get status(): number {
    return this.problem.status;
  }
  get code(): string | undefined {
    return this.problem.code;
  }
}

/** 412: `If-Match` didn't match, so the resource changed since it was read (D29). */
export class StaleVersion extends ApiUserProblem {
  override name = 'StaleVersion';
}

/** api-user couldn't be reached (network, CORS or a timeout). */
export class ApiUserUnavailable extends Error {
  override name = 'ApiUserUnavailable';
}

/** There is no Clerk session, so no request was sent. */
export class NotSignedIn extends Error {
  override name = 'NotSignedIn';
}

/**
 * The API codes that refuse what the person sent or chose (validation, limits, their content's
 * state, a change made meanwhile in another tab, an agreement to give first). Their own message is
 * about the person's input, so web may show it. Every other answer (a technical or protocol 4xx
 * such as `if_match_required` or `idempotency_key_reused`, an unknown or missing code, any 5xx) is
 * shown only as `TRY_AGAIN_LATER` (Joel, 2026-11-09; Codex review of #206).
 */
export const INPUT_REFUSALS: ReadonlySet<string> = new Set([
  // What they wrote or chose
  'validation_failed',
  'story_text_too_long',
  'story_text_too_short',
  'theme_count',
  'themes_changed',
  // Limits
  'weekly_submission_limit_reached',
  'draft_limit_reached',
  'upload_limit_reached',
  // Their upload or picture
  'media_over_limit',
  'media_failed',
  'media_not_uploaded',
  'media_processing',
  'image_not_uploaded',
  'image_changed',
  'nothing_to_resume',
  // A moderator approving a story whose file isn't ready yet (Joel, 2026-11-10, E-9; M3 plan PR 6)
  'media_not_ready',
  'media_recently_uploaded',
  'media_still_processing',
  // A moderator's decision on a story another moderator decided first (D-1), or in a state
  // that no longer allows it
  'already_decided',
  'wrong_status',
  // Their story's state
  'story_locked',
  'story_not_submittable',
  'story_not_editable',
  // Changed meanwhile (another tab, another admin)
  'stale_version',
  'agreement_version_changed',
  'document_changed',
  // The Staff page: removing or demoting the last Admin
  'last_admin',
  // An agreement to give first
  'terms_agreement_required',
  'testimony_consent_required',
]);

/**
 * The API codes that are about our side, never what the person sent: protocol and technical
 * refusals (a bug in how our page called the API), the backend failing or unavailable, and what
 * would help an attacker. People see only `TRY_AGAIN_LATER` for these, as for any code in neither
 * list (Joel, 2026-11-09: "errors caused by user mistakes should be visible. errors where the
 * backend is crashing or would be useful for attackers should be generic to the public (except
 * for the restart countdown)"). `service_restarting` is here too, but web names a restart and
 * counts down to when to try again (`restartWait`). The list doesn't change behaviour; it's there
 * so error-codes.spec.ts can check every code the APIs answer is in one list or the other.
 */
export const SYSTEM_CODES: ReadonlySet<string> = new Set([
  // How our page called the API
  'if_match_required',
  'idempotency_key_required',
  'idempotency_key_reused',
  'invalid_cursor',
  'unknown_parameter',
  'not_with_paging',
  'invalid_signature',
  // Who's asking: handled by the page itself (sign-in, "This page is for admins")
  'unknown_person',
  'role_required',
  // On the block list (G21 D): people see only the generic message
  'blocked',
  // Not found: pages that expect it explain it themselves ("this draft no longer exists")
  'not_found',
  'story_not_found',
  // The backend failing or unavailable
  'database_refused',
  'sign_in_unavailable',
  'uploads_unavailable',
  'upload_outcome_unknown',
  'export_unavailable',
  'clerk_unavailable',
  'service_restarting',
]);

/** Whether `err` is a 4xx refusing what the person sent, by a code in `INPUT_REFUSALS`. */
export const isInputRefusal = (err: unknown): boolean =>
  err instanceof ApiUserProblem &&
  err.status < 500 &&
  err.code !== undefined &&
  INPUT_REFUSALS.has(err.code);

/**
 * Whether people see only `TRY_AGAIN_LATER` for `err`: anything but being signed out or an input
 * refusal (`isInputRefusal`). That covers a 5xx answer, the database restarting, no answer, a
 * technical 4xx and anything else unexpected; never its code, status or detail (Joel, 2026-11-09).
 */
export const isSystemError = (err: unknown): boolean =>
  !(err instanceof NotSignedIn) && !isInputRefusal(err);

/**
 * The seconds until it's worth trying again if `err` is the database restarting (a `503
 * service_restarting`), else undefined. Web names a restart and counts down (Joel, 2026-11-09:
 * "reveal when compute is restarting with a count down but for any other error it should be
 * generic").
 */
export const restartWait = (err: unknown): number | undefined =>
  err instanceof ApiUserProblem ? err.restartingSeconds : undefined;

/**
 * What to tell the person: an input refusal's own message (its `detail`, about what they sent) or
 * `fallback`; for anything else, only `TRY_AGAIN_LATER` (Joel, 2026-11-09), then `kept` if given
 * (what of theirs is safe, e.g. "Your story is kept on this device.").
 */
export function plainMessage(
  err: unknown,
  fallback: string,
  kept?: string,
): string {
  if (isSystemError(err))
    return kept ? `${TRY_AGAIN_LATER} ${kept}` : TRY_AGAIN_LATER;
  if (err instanceof ApiUserProblem && err.problem.detail) {
    return err.problem.detail;
  }
  return fallback;
}

/** A strong `If-Match` for an aggregate's `version` (D29). */
export const ifMatch = (version: number): string => `"${version}"`;

/** A new `Idempotency-Key` (16–128 characters); reuse it when retrying the same command. */
export const newIdempotencyKey = (): string => crypto.randomUUID();

export interface ApiUserResponse<T> {
  status: number;
  /** The JSON body; undefined for `304` and empty answers. */
  data: T | undefined;
  etag: string | null;
  location: string | null;
}

export interface CommandOptions {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** The resource's `version`, for commands that modify it. */
  version?: number;
  /**
   * A tag the API gave out to send back in `If-Match` instead of a version: a moderator's
   * decision names the story's `reviewTag` (G14 B).
   */
  tag?: string;
  /** Required on non-idempotent `POST`s. */
  idempotencyKey?: string;
  /** `PATCH` bodies are JSON Merge Patch (D28). */
  mergePatch?: boolean;
}

export interface ApiUser {
  get<T>(
    path: string,
    options?: { ifNoneMatch?: string },
  ): Promise<ApiUserResponse<T>>;
  command<T>(
    path: string,
    options: CommandOptions,
  ): Promise<ApiUserResponse<T>>;
}

/** A call that doesn’t answer in this time counts as unavailable (Cloud Run cold starts included). */
const TIMEOUT_MS = 30_000;

/** The client for api-user at `baseUrl` (from `API_USER_URL`), with Clerk's `getToken`. */
export function apiUser(baseUrl: string, getToken: GetToken): ApiUser {
  if (typeof window === 'undefined') {
    throw new Error('api-user is called from the browser only (D32)');
  }
  const base = baseUrl.replace(/\/+$/, '');

  async function call<T>(
    method: string,
    path: string,
    set: (headers: Headers) => void,
    body?: string,
  ): Promise<ApiUserResponse<T>> {
    const token = await getToken();
    if (!token) throw new NotSignedIn('Not signed in');
    const headers = new Headers();
    headers.set('Authorization', `Bearer ${token}`);
    headers.set('Accept', 'application/json, application/problem+json');
    set(headers);
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers,
        body,
        // No cookies: api-user takes the token in Authorization only (D31).
        credentials: 'omit',
        cache: 'no-store',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new ApiUserUnavailable(
        `api-user could not be reached: ${err instanceof Error ? err.name : 'error'}`,
      );
    }
    if (!res.ok && res.status !== 304) throw await problemOf(res);
    // Answered: if the database was restarting, it's back.
    clearRestarting();
    // A success whose body is cut off or isn't JSON tells us nothing about what was done: the
    // command may well have applied. It's an unknown outcome, like no answer at all, so callers
    // keep their Idempotency-Key and try again (Codex #118).
    let data: T | undefined;
    try {
      const text = res.status === 304 ? '' : await res.text();
      data = text ? (JSON.parse(text) as T) : undefined;
    } catch (err) {
      throw new ApiUserUnavailable(
        `api-user's answer could not be read: ${err instanceof Error ? err.name : 'error'}`,
      );
    }
    return {
      status: res.status,
      data,
      etag: res.headers.get('ETag'),
      location: res.headers.get('Location'),
    };
  }

  return {
    get: (path, { ifNoneMatch } = {}) =>
      call('GET', path, (h) => {
        if (ifNoneMatch) h.set('If-None-Match', ifNoneMatch);
      }),
    command: (path, o) =>
      call(
        o.method,
        path,
        (h) => {
          if (o.body !== undefined) {
            h.set(
              'Content-Type',
              o.mergePatch
                ? 'application/merge-patch+json'
                : 'application/json',
            );
          }
          if (o.version !== undefined) h.set('If-Match', ifMatch(o.version));
          else if (o.tag !== undefined) h.set('If-Match', `"${o.tag}"`);
          if (o.idempotencyKey) h.set('Idempotency-Key', o.idempotencyKey);
        },
        o.body === undefined ? undefined : JSON.stringify(o.body),
      ),
  };
}

/** The answer's problem, or a bare one when the body isn't a problem (e.g. a proxy's 502). */
async function problemOf(res: Response): Promise<ApiUserProblem> {
  let problem: Problem = {
    type: 'about:blank',
    title: res.statusText || 'Error',
    status: res.status,
  };
  if (
    (res.headers.get('Content-Type') ?? '').startsWith(
      'application/problem+json',
    )
  ) {
    try {
      const body = (await res.json()) as Partial<Problem>;
      if (body && typeof body === 'object' && body.status === res.status) {
        problem = { ...problem, ...body } as Problem;
      }
    } catch {
      // Not JSON after all: keep the bare problem.
    }
  }
  let restarting: number | undefined;
  if (problem.status === 503 && problem.code === 'service_restarting') {
    restarting = restartingSeconds(
      (problem as { retryAfterSeconds?: unknown }).retryAfterSeconds,
      res.headers.get('Retry-After'),
    );
    reportRestarting(restarting);
  }
  if (res.status === 428) {
    // Our bug: a command that modifies a resource went without If-Match.
    console.error('api-user: If-Match was missing on a command (428)');
  }
  return res.status === 412
    ? new StaleVersion(problem)
    : new ApiUserProblem(problem, restarting);
}
