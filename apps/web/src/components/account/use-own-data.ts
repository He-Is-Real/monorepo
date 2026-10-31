'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiUser } from '@/lib/api-user';
import {
  personalApiUser,
  type PersonalSession,
  personalSession,
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
  const readRef = useRef(read);
  readRef.current = read;
  const userId = session.status === 'signed-in' ? session.userId : null;

  const start = useCallback((owner: string, quiet = false) => {
    // Someone who has gone (a command of theirs finishing late) mustn't cancel or hide the
    // current person's load: nothing changes for them.
    const now = signedInAs(owner);
    if (!now) return Promise.resolve();
    const mine = ++load.current;
    if (!quiet) setState({ status: 'loading' });
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

/** This person's session, if they are the one signed in right now (the live state, not a render's). */
export function signedInAs(owner: string): SignedIn | null {
  const now = personalSession();
  return now.status === 'signed-in' && now.userId === owner ? now : null;
}

/**
 * A message about one person's own things (“‘My story’ is deleted.”): shown only while they are
 * signed in, and forgotten once anyone else signs in or they sign out, so nobody sees another
 * person's. `say` from a command that finishes after the person changed is dropped.
 */
export function useOwnNotice<M>() {
  const session = usePersonalSession();
  const userId = session.status === 'signed-in' ? session.userId : null;
  const [notice, setNotice] = useState<{ owner: string; value: M } | null>(
    null,
  );
  if (notice && notice.owner !== userId) setNotice(null);
  return {
    notice: notice && notice.owner === userId ? notice.value : undefined,
    say: (owner: string, value: M | undefined) => {
      if (signedInAs(owner))
        setNotice(value === undefined ? null : { owner, value });
    },
  };
}
