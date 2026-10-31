/**
 * Clerk's Backend API, as housekeeping sees it: delete one user, for an erasure whose Clerk
 * deletion failed when api-user tried it (D39, D40; D81: account deletion is one of the server
 * jobs that may use Clerk's secret key). The key (`clerk-secret-key`) goes to Clerk's API only
 * and is never logged.
 */
export interface ClerkUsers {
  /** Deletes the Clerk user, which ends their sessions; one already gone is fine. */
  delete(clerkUserId: string): Promise<void>;
}

const API = 'https://api.clerk.com/v1';
const TIMEOUT_MS = 15_000;
/** Clerk's user ids; anything else never reaches a URL. */
export const CLERK_USER_ID = /^user_[A-Za-z0-9]{1,64}$/;
/** Clerk's secret keys. */
export const CLERK_SECRET_KEY = /^sk_(test|live)_/;

export class ClerkBackendUsers implements ClerkUsers {
  constructor(
    private readonly key: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async delete(clerkUserId: string): Promise<void> {
    if (!CLERK_USER_ID.test(clerkUserId))
      throw new Error('Not a Clerk user id');
    const res = await this.fetcher(`${API}/users/${clerkUserId}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${this.key}`,
        Accept: 'application/json',
      },
      // The key goes to Clerk's API only, never on to wherever a redirect points.
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`Clerk user delete answered ${res.status}`);
    }
  }
}
