import { Logger } from '@nestjs/common';
import type { SecretsService } from '@heisreal/secrets';
import { svixKey } from './svix';

/**
 * Clerk's Backend API, for erasure only (D39, D81: account deletion is one of the three server jobs
 * that may use Clerk's secret key). The key (`clerk-secret-key`, which only api-user may read)
 * and the webhook's signing secret come from Secret Manager the first time they're needed, not at
 * startup: a secret with no version yet (before the owner adds it) then turns off only what needs
 * it, and a version added later works without a redeploy. Neither is ever logged.
 */
export const CLERK_BACKEND = Symbol('CLERK_BACKEND');

const API = 'https://api.clerk.com/v1';
const TIMEOUT_MS = 15_000;
/** Clerk's user ids; anything else never reaches a URL. */
export const CLERK_USER_ID = /^user_[A-Za-z0-9]{1,64}$/;

export interface ClerkBackend {
  /**
   * Deletes the Clerk user, which ends all their sessions; one already gone is fine. Throws if
   * Clerk can't be reached or the key isn't set.
   */
  deleteUser(clerkUserId: string): Promise<void>;
  /** The webhook endpoint's Svix key, or null while the secret isn't set (webhooks answer 503). */
  webhookKey(): Promise<Buffer | null>;
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
    if (!CLERK_USER_ID.test(clerkUserId)) {
      throw new Error('Not a Clerk user id');
    }
    if (!this.keySecret) {
      throw new Error('Clerk deletion is off (no CLERK_SECRET_KEY_SECRET)');
    }
    const key = (await this.secrets.get(this.keySecret)).trim();
    if (!/^sk_(test|live)_/.test(key)) {
      throw new Error(`Secret ${this.keySecret} isn't a Clerk secret key`);
    }
    const res = await this.fetcher(`${API}/users/${clerkUserId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      // The key goes to Clerk's API only, never on to wherever a redirect points.
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`Clerk user delete answered ${res.status}`);
    }
  }

  async webhookKey(): Promise<Buffer | null> {
    if (!this.webhookSecret) return null;
    try {
      return svixKey(await this.secrets.get(this.webhookSecret));
    } catch (err) {
      // No version yet, or not a whsec_ secret: Svix retries until the owner adds it.
      this.logger.warn(
        `Clerk webhooks are off: secret ${this.webhookSecret} isn't readable as a signing secret (${err instanceof Error ? err.name : 'error'})`,
      );
      return null;
    }
  }
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
    if (!SECRET_NAME.test(value)) throw new Error(`${what} must be a secret name`);
    return value;
  };
  return new ClerkBackendApi(
    secrets,
    name(env['CLERK_SECRET_KEY_SECRET'], 'CLERK_SECRET_KEY_SECRET'),
    name(env['CLERK_WEBHOOK_SECRET_SECRET'], 'CLERK_WEBHOOK_SECRET_SECRET'),
  );
}
