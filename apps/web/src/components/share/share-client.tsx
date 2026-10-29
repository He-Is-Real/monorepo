'use client';

import { useAuth } from '@clerk/react';
import { useEffect, useMemo, useState } from 'react';
import { e2eFixtureToken } from '@/components/auth/account-control';
import { ClerkBrowser } from '@/components/auth/clerk-browser';
import { type ApiUser, apiUser } from '@/lib/api-user';
import type { ShareLegal } from '@/lib/share-legal';
import { ShareFlow } from './share-flow';

/**
 * The submit flow with the signed-in person's api-user client: Clerk in the browser (D32), its
 * `getToken()` on every call. Without Clerk's key or api-user's address, sharing isn't
 * available on this deployment.
 */
export function ShareWithClerk({
  publishableKey,
  apiUserUrl,
  legal,
}: {
  publishableKey: string;
  apiUserUrl: string;
  legal: ShareLegal;
}) {
  return (
    <ClerkBrowser publishableKey={publishableKey}>
      <ShareSignedIn apiUserUrl={apiUserUrl} legal={legal} />
    </ClerkBrowser>
  );
}

function ShareSignedIn({
  apiUserUrl,
  legal,
}: {
  apiUserUrl: string;
  legal: ShareLegal;
}) {
  const { isLoaded, isSignedIn, getToken, userId } = useAuth();
  // One client per signed-in person; getToken is asked on every call.
  const api = useMemo(
    () => (isSignedIn && userId ? apiUser(apiUserUrl, () => getToken()) : null),
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
