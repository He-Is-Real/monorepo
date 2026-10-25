'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { type Account, apiUser, type GetToken } from '@/lib/api-user';

/**
 * The account bootstrap (M2): once a page has loaded signed in, the browser calls api-user's
 * `GET /v1/account` once, with the person's Clerk token (D31, D83). The first call creates the
 * person's account row, which staff need before api-admin knows them; the answer says whether
 * the sign-up consent form still needs accepting (`signupConsent`, D73).
 *
 * Once per page load and signed-in person: client-side navigation keeps the header, so it
 * doesn't call again, and a different person signing in calls again. Nothing is stored in the
 * browser. **A failure blocks nothing**: the header and the page work as before, and the state
 * is just `failed`.
 */
export type AccountBootstrap =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; account: Account }
  | { status: 'failed' };

let state: { userId: string | null; bootstrap: AccountBootstrap } = {
  userId: null,
  bootstrap: { status: 'idle' },
};
const listeners = new Set<() => void>();

function set(userId: string | null, bootstrap: AccountBootstrap) {
  state = { userId, bootstrap };
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const IDLE: AccountBootstrap = { status: 'idle' };

/**
 * Runs the bootstrap for the signed-in person (`userId`, Clerk's user id; null when signed
 * out), against api-user at `baseUrl` (none: nothing happens). Returns its state, for the
 * personal parts of pages.
 */
export function useAccountBootstrap(
  userId: string | null | undefined,
  baseUrl: string | undefined,
  getToken: GetToken,
): AccountBootstrap {
  useEffect(() => {
    if (!userId || !baseUrl) {
      if (state.userId !== null) set(null, IDLE);
      return;
    }
    if (state.userId === userId) return; // already called for this person on this page load
    set(userId, { status: 'loading' });
    apiUser(baseUrl, getToken)
      .get<Account>('/v1/account')
      .then(({ data }) => {
        if (state.userId !== userId) return; // signed out or switched meanwhile
        set(
          userId,
          data ? { status: 'ready', account: data } : { status: 'failed' },
        );
      })
      .catch(() => {
        if (state.userId === userId) set(userId, { status: 'failed' });
      });
    // Not getToken: its identity changes on Clerk updates, and the person is what matters.
  }, [userId, baseUrl]);

  return useSyncExternalStore(
    subscribe,
    () => (userId && state.userId === userId ? state.bootstrap : IDLE),
    () => IDLE,
  );
}
