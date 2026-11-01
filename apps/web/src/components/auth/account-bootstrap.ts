'use client';

import { useEffect, useSyncExternalStore } from 'react';
import {
  type Account,
  type AgreementState,
  apiUser,
  type GetToken,
} from '@/lib/api-user';

/**
 * The account bootstrap (M2): once a page has loaded signed in, the browser calls api-user's
 * `GET /v1/account` once, with the person's Clerk token (D31, D83). The first call creates the
 * person's account row, which staff need before api-admin knows them; the answer says where
 * they stand with the terms of use and the testimony consent (plan 4e).
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

/**
 * Agreements the person made on this page load (agreement-step.tsx), by Clerk user id. Folded
 * into every account the bootstrap reports for them, so an answer that was already on its way
 * when they agreed (and so still says "not up to date") can't send them back to the step.
 */
let confirmed: {
  userId: string;
  termsOfUse?: AgreementState;
  testimonyConsent?: AgreementState;
} | null = null;

function reconcile(
  userId: string | null,
  bootstrap: AccountBootstrap,
): AccountBootstrap {
  if (bootstrap.status !== 'ready' || !userId || confirmed?.userId !== userId)
    return bootstrap;
  const account = bootstrap.account;
  const newer = (mine: AgreementState | undefined, theirs: AgreementState) =>
    mine && (mine.agreed?.version ?? -1) >= (theirs.agreed?.version ?? -1)
      ? mine
      : theirs;
  return {
    status: 'ready',
    account: {
      ...account,
      termsOfUse: newer(confirmed.termsOfUse, account.termsOfUse),
      testimonyConsent: newer(
        confirmed.testimonyConsent,
        account.testimonyConsent,
      ),
    },
  };
}

function set(userId: string | null, bootstrap: AccountBootstrap) {
  state = { userId, bootstrap: reconcile(userId, bootstrap) };
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

/**
 * The bootstrap's state for the page's signed-in person, without starting it: for the parts of
 * the page outside the header (the agreement steps and banner, consent-prompts.tsx; the
 * device hearts prompt), which read what the header's bootstrap found. With `userId`, only that
 * person's: idle for anyone else, so one person's state never reaches another's (hearts, M2).
 */
export function useAccountState(userId?: string | null): AccountBootstrap {
  return useSyncExternalStore(
    subscribe,
    () =>
      userId === undefined || (userId && state.userId === userId)
        ? state.bootstrap
        : IDLE,
    () => IDLE,
  );
}

/**
 * The person (`userId`, Clerk's user id) has just agreed (`agreed`, api-user's answer): the site
 * treats it as agreed for the rest of this page load, whatever a bootstrap answer sent before it
 * says. The next page load asks api-user afresh.
 */
export function confirmAgreement(
  userId: string,
  agreement: 'termsOfUse' | 'testimonyConsent',
  agreed: AgreementState,
): void {
  if (confirmed?.userId !== userId) confirmed = { userId };
  confirmed[agreement] = agreed;
  set(state.userId, state.bootstrap);
}
