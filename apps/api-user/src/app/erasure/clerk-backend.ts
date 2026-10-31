import { Logger } from '@nestjs/common';
import type { SecretsService } from '@heisreal/secrets';
import { svixKey } from './svix';

/**
 * Clerk's Backend API, for erasure and the data download only (D39, D81: account deletion and the
 * data download are two of the three server jobs that may use Clerk's secret key). The key
 * (`clerk-secret-key`, which only api-user may read) and the webhook's signing secret come from
 * Secret Manager when needed, not at startup, and are read again once they are more than
 * `SECRET_MAX_AGE_MS` old: a secret with no version yet (before the owner adds it) turns off only
 * what needs it, and a version added, corrected or rotated later is used within five minutes, on
 * every instance, without a redeploy (the old version must stay enabled until then). Neither is
 * ever logged.
 */
export const CLERK_BACKEND = Symbol('CLERK_BACKEND');

const API = 'https://api.clerk.com/v1';
const TIMEOUT_MS = 15_000;
/** How long a Clerk secret read from Secret Manager is used before it is read again. */
export const SECRET_MAX_AGE_MS = 5 * 60_000;
/** Clerk's user ids; anything else never reaches a URL. */
export const CLERK_USER_ID = /^user_[A-Za-z0-9]{1,64}$/;

export interface ClerkBackend {
  /**
   * Deletes the Clerk user, which ends all their sessions; one already gone is fine. Throws if
   * Clerk can't be reached or the key isn't set.
   */
  deleteUser(clerkUserId: string): Promise<void>;
  /**
   * What Clerk holds about the person, for "Download my data" (Art 15). Throws if Clerk can't be
   * reached, the key isn't set or the user isn't there: the download is all or nothing.
   */
  getUser(clerkUserId: string): Promise<ClerkProfile>;
  /** The webhook endpoint's Svix key, or null while the secret isn't set (webhooks answer 503). */
  webhookKey(): Promise<Buffer | null>;
}

/** The sign-in details Clerk holds (the contract's `AccountExport.signIn`). */
export interface ClerkProfile {
  clerkUserId: string;
  firstName: string | null;
  lastName: string | null;
  username: string | null;
  emailAddresses: {
    emailAddress: string;
    primary: boolean;
    verified: boolean;
  }[];
  phoneNumbers: { phoneNumber: string; primary: boolean; verified: boolean }[];
  connectedAccounts: { provider: string; emailAddress: string | null }[];
  profileImageUrl: string | null;
  twoFactorEnabled: boolean;
  createdAt: string | null;
  lastSignInAt: string | null;
  lastActiveAt: string | null;
}

type Env = Record<string, string | undefined>;
type Secrets = Pick<SecretsService, 'get'>;
const SECRET_NAME = /^[A-Za-z0-9_-]{1,255}$/;

export class ClerkBackendApi implements ClerkBackend {
  private readonly logger = new Logger('ClerkBackend');

  constructor(
    private readonly secrets: Secrets,
    private readonly keySecret: string | null,
    private readonly webhookSecret: string | null,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async deleteUser(clerkUserId: string): Promise<void> {
    const res = await this.call('DELETE', clerkUserId);
    if (!res.ok && res.status !== 404) {
      throw new Error(`Clerk user delete answered ${res.status}`);
    }
  }

  async getUser(clerkUserId: string): Promise<ClerkProfile> {
    const res = await this.call('GET', clerkUserId);
    if (!res.ok) throw new Error(`Clerk user read answered ${res.status}`);
    return clerkProfile(clerkUserId, await res.json());
  }

  private async call(method: 'GET' | 'DELETE', clerkUserId: string) {
    if (!CLERK_USER_ID.test(clerkUserId)) {
      throw new Error('Not a Clerk user id');
    }
    if (!this.keySecret) {
      throw new Error(
        'Clerk’s Backend API is off (no CLERK_SECRET_KEY_SECRET)',
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
    return this.fetcher(`${API}/users/${clerkUserId}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      // The key goes to Clerk's API only, never on to wherever a redirect points.
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  async webhookKey(): Promise<Buffer | null> {
    if (!this.webhookSecret) return null;
    try {
      return svixKey(
        await this.secrets.get(this.webhookSecret, 'latest', {
          maxAgeMs: SECRET_MAX_AGE_MS,
        }),
      );
    } catch (err) {
      // No version yet, or not a whsec_ secret: Svix retries until the owner adds it.
      this.logger.warn(
        `Clerk webhooks are off: secret ${this.webhookSecret} isn't readable as a signing secret (${err instanceof Error ? err.name : 'error'})`,
      );
      return null;
    }
  }
}

const text = (v: unknown): string | null =>
  typeof v === 'string' && v !== '' ? v : null;
const time = (v: unknown): string | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0
    ? new Date(v).toISOString()
    : null;
const list = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v)
    ? v.filter(
        (x): x is Record<string, unknown> => !!x && typeof x === 'object',
      )
    : [];
const verified = (x: Record<string, unknown>) =>
  (x['verification'] as { status?: unknown } | null)?.status === 'verified';

/**
 * Clerk's user object (Backend API, `GET /users/{id}`) as the export shows it: the fields a person
 * gave Clerk or that describe their sign-in, picked one by one, so nothing Clerk adds later (or our
 * own metadata) reaches the file unread.
 */
export function clerkProfile(clerkUserId: string, raw: unknown): ClerkProfile {
  const u = (raw && typeof raw === 'object' ? raw : {}) as Record<
    string,
    unknown
  >;
  if (u['id'] !== clerkUserId)
    throw new Error('Clerk answered for another user');
  return {
    clerkUserId,
    firstName: text(u['first_name']),
    lastName: text(u['last_name']),
    username: text(u['username']),
    emailAddresses: list(u['email_addresses']).flatMap((e) =>
      typeof e['email_address'] === 'string'
        ? [
            {
              emailAddress: e['email_address'],
              primary: e['id'] === u['primary_email_address_id'],
              verified: verified(e),
            },
          ]
        : [],
    ),
    phoneNumbers: list(u['phone_numbers']).flatMap((p) =>
      typeof p['phone_number'] === 'string'
        ? [
            {
              phoneNumber: p['phone_number'],
              primary: p['id'] === u['primary_phone_number_id'],
              verified: verified(p),
            },
          ]
        : [],
    ),
    connectedAccounts: list(u['external_accounts']).flatMap((a) =>
      typeof a['provider'] === 'string'
        ? [{ provider: a['provider'], emailAddress: text(a['email_address']) }]
        : [],
    ),
    // Clerk always has an image_url (a generated avatar); it's the person's only if has_image.
    profileImageUrl: u['has_image'] === true ? text(u['image_url']) : null,
    twoFactorEnabled: u['two_factor_enabled'] === true,
    createdAt: time(u['created_at']),
    lastSignInAt: time(u['last_sign_in_at']),
    lastActiveAt: time(u['last_active_at']),
  };
}

/**
 * `CLERK_SECRET_KEY_SECRET` names the Backend API key's secret, `CLERK_WEBHOOK_SECRET_SECRET` the
 * webhook endpoint's signing secret. Either may be unset: Clerk deletions then wait in the queue
 * (pendingDeletion), and the webhook answers 503.
 */
export function createClerkBackend(
  secrets: Secrets,
  env: Env = process.env,
): ClerkBackend {
  const name = (v: string | undefined, what: string) => {
    const value = v?.trim() ?? '';
    if (value === '') return null;
    if (!SECRET_NAME.test(value))
      throw new Error(`${what} must be a secret name`);
    return value;
  };
  return new ClerkBackendApi(
    secrets,
    name(env['CLERK_SECRET_KEY_SECRET'], 'CLERK_SECRET_KEY_SECRET'),
    name(env['CLERK_WEBHOOK_SECRET_SECRET'], 'CLERK_WEBHOOK_SECRET_SECRET'),
  );
}
