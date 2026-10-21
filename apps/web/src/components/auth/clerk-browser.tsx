'use client';

import { ClerkProvider } from '@clerk/react';

/**
 * Clerk runs in the browser only (D32): this client component loads Clerk's browser SDK with
 * the instance's publishable key (public). web's server never sees a session token, holds no
 * Clerk secret, and never calls api-user or api-admin; the browser does, with `getToken()`.
 */
export function ClerkBrowser({
  publishableKey,
  children,
}: {
  publishableKey: string;
  children: React.ReactNode;
}) {
  return (
    <ClerkProvider publishableKey={publishableKey}>{children}</ClerkProvider>
  );
}
