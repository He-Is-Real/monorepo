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
 * - **412 means the resource changed since it was read** ({@link StaleVersion}): re-read it,
 *   re-apply the change if nothing it touched has changed, and ask the person only on a real
 *   clash (D70). **428 means we forgot `If-Match`**, a bug in our code, never the person's.
 * - Commands that modify an existing resource send `If-Match` with its `version`
 *   ({@link ifMatch}); non-idempotent `POST`s send an `Idempotency-Key`
 *   ({@link newIdempotencyKey}), kept and reused when retrying the same command (D29).
 * - **api-admin too:** staff pages (`/admin/legal`) call api-admin with this same client at
 *   api-admin's origin (`API_ADMIN_URL`): the same token, the same rules (D31).
 */

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
  role: 'Viewer' | 'User' | 'Moderator' | 'Admin' | 'SuperAdmin';
  createdAt: string;
  signupConsent: { accepted: boolean };
  /** D85: a newer testimony form must be accepted before a new story (the banner). */
  testimonyConsent: { acceptanceRequired: boolean };
}

/** api-user answered with an error (anything but 2xx and 304). */
export class ApiUserProblem extends Error {
  constructor(readonly problem: Problem) {
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
  if (res.status === 428) {
    // Our bug: a command that modifies a resource went without If-Match.
    console.error('api-user: If-Match was missing on a command (428)');
  }
  return res.status === 412
    ? new StaleVersion(problem)
    : new ApiUserProblem(problem);
}
