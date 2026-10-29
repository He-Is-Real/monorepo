'use client';

import { useEffect, useSyncExternalStore } from 'react';
import type { GetToken } from '@/lib/api-user';

/**
 * Who is looking, for the personal parts of pages outside the header (hearts, "My favourites";
 * D83). Clerk runs only inside the header's account control (site-header.tsx), so that control
 * publishes the person's state here and the rest of the page reads it. Browser only: web's
 * server never knows (D32), so every page renders the same and these parts fill in afterwards.
 *
 * - `unknown`: nothing has said yet (the page is loading, Clerk is loading, or the site has no
 *   sign-in).
 * - `signed-out`.
 * - `signed-in`: `userId` (Clerk's), Clerk's `getToken` and api-user's address, for api-user.ts.
 *   Without an address (`API_USER_URL` unset) nobody counts as signed in here.
 */
export type PersonalSession =
  | { status: 'unknown' | 'signed-out' }
  | {
      status: 'signed-in';
      userId: string;
      apiUserUrl: string;
      getToken: GetToken;
    };

const UNKNOWN: PersonalSession = { status: 'unknown' };
let current: PersonalSession = UNKNOWN;
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

function publish(next: PersonalSession) {
  const same =
    next.status === current.status &&
    (next.status !== 'signed-in' ||
      (current.status === 'signed-in' &&
        next.userId === current.userId &&
        next.apiUserUrl === current.apiUserUrl));
  // A new getToken for the same person (Clerk re-renders) doesn't wake every heart.
  if (same) {
    if (next.status === 'signed-in') current = next;
    return;
  }
  current = next;
  for (const listener of listeners) listener();
}

/** The current state, for code outside React (the favourites store). */
export const personalSession = (): PersonalSession => current;
export const onPersonalSession = subscribe;

/**
 * The header's account control says who is signed in (`userId` null = signed out, undefined =
 * Clerk is still loading). Called by account-control.tsx only.
 */
export function usePublishPersonalSession(
  userId: string | null | undefined,
  apiUserUrl: string | undefined,
  getToken: GetToken,
): void {
  useEffect(() => {
    if (userId === undefined) return;
    const next: PersonalSession =
      userId && apiUserUrl
        ? { status: 'signed-in', userId, apiUserUrl, getToken }
        : { status: 'signed-out' };
    publish(next);
  });
}

/** The person's state, for personal parts of pages; `unknown` on the server and while hydrating. */
export function usePersonalSession(): PersonalSession {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => UNKNOWN,
  );
}
