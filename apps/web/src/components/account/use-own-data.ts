'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiUser } from '@/lib/api-user';
import {
  personalApiUser,
  type PersonalSession,
  usePersonalSession,
} from '@/lib/personal-session';

type SignedIn = Extract<PersonalSession, { status: 'signed-in' }>;

export type OwnData<T> =
  | { status: 'loading' }
  | { status: 'signed-out' }
  | { status: 'failed'; owner: string }
  | { status: 'ready'; owner: string; data: T };

/**
 * Something of the signed-in person's own, read from api-user in the browser (D83), for the
 * profile's parts. Like My favourites (Codex, #117): an answer is used only while the same person
 * is still signed in and no newer load has started, so nobody ever sees someone else's.
 *
 * `reload()` reads it again (after a command); `api()` is api-user for this person only, or null
 * once they're gone.
 */
export function useOwnData<T>(read: (api: ApiUser) => Promise<T>) {
  const session = usePersonalSession();
  const [state, setState] = useState<OwnData<T>>({ status: 'loading' });
  const load = useRef(0);
  const current = useRef(session);
  current.current = session;
  const readRef = useRef(read);
  readRef.current = read;
  const userId = session.status === 'signed-in' ? session.userId : null;

  const signedInAs = (owner: string): SignedIn | null => {
    const now = current.current;
    return now.status === 'signed-in' && now.userId === owner ? now : null;
  };

  const start = useCallback((owner: string, quiet = false) => {
    const mine = ++load.current;
    if (!quiet) setState({ status: 'loading' });
    const now = signedInAs(owner);
    if (!now) return Promise.resolve();
    return readRef.current(personalApiUser(now)).then(
      (data) => {
        if (load.current === mine && signedInAs(owner))
          setState({ status: 'ready', owner, data });
      },
      () => {
        if (load.current === mine && signedInAs(owner))
          setState({ status: 'failed', owner });
      },
    );
  }, []);

  useEffect(() => {
    if (userId) void start(userId);
    else load.current += 1; // signed out: drop anything still on its way
  }, [userId, start]);

  const api = (owner: string): ApiUser | null => {
    const now = signedInAs(owner);
    return now ? personalApiUser(now) : null;
  };

  // Someone else's (the person changed a moment ago) is never shown: loading instead.
  const shown: OwnData<T> =
    session.status === 'signed-out'
      ? { status: 'signed-out' }
      : session.status === 'unknown' ||
          state.status === 'loading' ||
          state.status === 'signed-out' ||
          state.owner !== userId
        ? { status: 'loading' }
        : state;

  return {
    state: shown,
    /** Reads it again; `quiet` keeps what's on screen until the answer comes. */
    reload: (owner: string, quiet = true) => start(owner, quiet),
    api,
  };
}
