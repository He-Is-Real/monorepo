import { Logger } from '@nestjs/common';
import type { SecretsService } from '@heisreal/secrets';

/**
 * Clerk's Backend API for staff roles (G8 B, Joel 2026-11-11: "clerk as a source of truth and
 * the table just to make it easy for admins to say who is admin"). A staff member's role is their
 * Clerk `publicMetadata.role`, which the session token carries as `role` (infra/clerk/dev.json).
 * No invitations (S-7, Joel 2026-11-11): a person signs up as an ordinary user first, then an
 * Admin adds their email. The one place api-admin talks to Clerk, so tests can fake it.
 *
 * The key (`clerk-secret-key`) comes from Secret Manager when first needed, and again once it is
 * more than five minutes old (a rotated key is used without a redeploy). Never logged.
 */
export const STAFF_CLERK = Symbol('STAFF_CLERK');

/** A staff role as Clerk holds it; `null` is none (a User). */
export type StaffRole = 'Moderator' | 'Admin';

export interface StaffClerk {
  /** Whether a key is configured; when not, staff changes and the baseline step are off. */
  readonly enabled: boolean;
  /**
   * Makes `email`'s Clerk role `role` (or none): every Clerk user with that verified email gets it
   * in `publicMetadata.role`. With no such user nothing changes (`count` 0). Throws if Clerk can't
   * be reached or answers an error.
   */
  setRole(email: string, role: StaffRole | null): Promise<StaffClerkChange>;
}

/** What Clerk changed, for the log (no ids or emails): how many accounts got the role. */
export interface StaffClerkChange {
  count: number;
}

const API = 'https://api.clerk.com/v1';
const TIMEOUT_MS = 15_000;
export const SECRET_MAX_AGE_MS = 5 * 60_000;
const CLERK_USER_ID = /^user_[A-Za-z0-9]{1,64}$/;
const SECRET_NAME = /^[A-Za-z0-9_-]{1,255}$/;

type Secrets = Pick<SecretsService, 'get'>;
type Json = Record<string, unknown>;

export class ClerkStaffApi implements StaffClerk {
  private readonly logger = new Logger('StaffClerk');

  constructor(
    private readonly secrets: Secrets,
    private readonly keySecret: string | null,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  get enabled(): boolean {
    return this.keySecret !== null;
  }

  async setRole(
    email: string,
    role: StaffRole | null,
  ): Promise<StaffClerkChange> {
    const users = list(
      await this.json('GET', `/users?${query({ email_address: email })}`),
    ).filter((u) => emailsOf(u).includes(email));
    // Ids checked before anything changes, so a bad answer changes nothing.
    const ids = users.map((user) => {
      const id = user['id'];
      if (typeof id !== 'string' || !CLERK_USER_ID.test(id)) {
        throw new Error('Clerk answered a user without a valid id');
      }
      return id;
    });
    for (const id of ids) {
      await this.json('PATCH', `/users/${id}/metadata`, {
        public_metadata: { role },
      });
    }
    return { count: ids.length };
  }

  private async json(
    method: 'GET' | 'PATCH',
    path: string,
    body?: object,
  ): Promise<unknown> {
    if (!this.keySecret) {
      throw new Error(
        "Clerk's Backend API is off (no CLERK_SECRET_KEY_SECRET)",
      );
    }
    const key = (
      await this.secrets.get(this.keySecret, 'latest', {
        maxAgeMs: SECRET_MAX_AGE_MS,
      })
    ).trim();
    if (!/^sk_(test|live)_/.test(key)) {
      throw new Error(`Secret ${this.keySecret} isn't a Clerk secret key`);
    }
    const res = await this.fetcher(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      // The key goes to Clerk's API only, never on to wherever a redirect points.
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      this.logger.warn(`Clerk ${method} answered ${res.status}`);
      throw new Error(`Clerk ${method} answered ${res.status}`);
    }
    const text = await res.text();
    return text ? (JSON.parse(text) as unknown) : null;
  }
}

const query = (params: Record<string, string>) =>
  new URLSearchParams(params).toString();

/** A list answer: a bare array, or `{ data: [...] }` (Clerk's paginated form). */
function list(value: unknown): Json[] {
  const items = Array.isArray(value)
    ? value
    : Array.isArray((value as Json | null)?.['data'])
      ? ((value as Json)['data'] as unknown[])
      : [];
  return items.filter((x): x is Json => !!x && typeof x === 'object');
}

/**
 * A Clerk user's verified email addresses, lower-case. Only verified ones count: someone who adds
 * a staff address to their own account without proving they own it never gets the role.
 */
function emailsOf(user: Json): string[] {
  const addresses = user['email_addresses'];
  if (!Array.isArray(addresses)) return [];
  return addresses.flatMap((raw) => {
    const a = (raw ?? {}) as Json;
    const verified =
      (a['verification'] as Json | null)?.['status'] === 'verified';
    return verified && typeof a['email_address'] === 'string'
      ? [a['email_address'].toLowerCase()]
      : [];
  });
}

/**
 * `CLERK_SECRET_KEY_SECRET` names the Backend API key's secret (the `gcp` root sets it). Unset
 * (local runs, tests): staff changes answer 502 and the baseline step is skipped.
 */
export function createStaffClerk(
  secrets: Secrets,
  env: Record<string, string | undefined> = process.env,
): StaffClerk {
  const name = env['CLERK_SECRET_KEY_SECRET']?.trim() ?? '';
  if (name !== '' && !SECRET_NAME.test(name)) {
    throw new Error('CLERK_SECRET_KEY_SECRET must be a secret name');
  }
  return new ClerkStaffApi(secrets, name === '' ? null : name);
}
