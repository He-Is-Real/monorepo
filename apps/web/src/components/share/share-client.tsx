'use client';

import { useAuth } from '@clerk/react';
import { useEffect, useMemo, useState } from 'react';
import { e2eFixtureToken } from '@/components/auth/account-control';
import { type ApiUser, apiUser } from '@/lib/api-user';
import { personalApiUser } from '@/lib/personal-session';
import type { ShareLegal } from '@/lib/share-legal';
import { ShareFlow } from './share-flow';

/**
 * The submit flow with the signed-in person's api-user client: the site's Clerk session in the
 * browser (app/layout.tsx, D32, D115), its `getToken()` on every call. Without Clerk's key or
 * api-user's address, sharing isn't available on this deployment.
 */
export function ShareWithClerk({
  apiUserUrl,
  legal,
}: {
  apiUserUrl: string;
  legal: ShareLegal;
}) {
  const { isLoaded, isSignedIn, getToken, userId } = useAuth();
  // One client per signed-in person, bound to them (Codex #118 round 4): Clerk's getToken reads
  // the active session on each call, so a save still running after someone else signs in would
  // otherwise go out with their token. Only a token whose `sub` is this person's is sent.
  const api = useMemo(
    () =>
      isSignedIn && userId
        ? personalApiUser({
            status: 'signed-in',
            userId,
            apiUserUrl,
            getToken: () => getToken(),
          })
        : null,
    // getToken's identity changes on Clerk updates; the person is what matters.
    [apiUserUrl, isSignedIn, userId],
  );
  return (
    <ShareFlow
      legal={legal}
      auth={
        !isLoaded
          ? { state: 'loading' }
          : api && userId
            ? { state: 'signed-in', api, owner: userId }
            : { state: 'signed-out' }
      }
    />
  );
}

/**
 * e2e only (E2E_FIXTURES): signed in with the fixture token (to the stub api-user), or signed
 * out, without Clerk (T4: no network).
 */
export function ShareWithFixture({
  signedIn,
  apiUserUrl,
  legal,
}: {
  signedIn: boolean;
  apiUserUrl: string;
  legal: ShareLegal;
}) {
  // Made after hydration (the browser-only client), so the server's HTML matches.
  const [api, setApi] = useState<ApiUser | null>(null);
  const [owner, setOwner] = useState('');
  useEffect(() => {
    setApi(signedIn ? apiUser(apiUserUrl, e2eFixtureToken) : null);
    // The fixture person, per test session (e2eFixtureToken's).
    void e2eFixtureToken().then(setOwner);
  }, [signedIn, apiUserUrl]);
  return (
    <ShareFlow
      legal={legal}
      auth={
        !signedIn
          ? { state: 'signed-out' }
          : api && owner
            ? { state: 'signed-in', api, owner }
            : { state: 'loading' }
      }
    />
  );
}
