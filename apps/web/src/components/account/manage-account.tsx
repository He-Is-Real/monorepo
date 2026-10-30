'use client';

import { useClerk } from '@clerk/react';
import { Button } from '@/components/ui/button';

/**
 * D81: name, email, password and Google sign-in are Clerk's, changed in Clerk's own "Manage
 * account" panel. We store none of them (D16), and there's no country or display name.
 */
export function ClerkManageAccount() {
  const clerk = useClerk();
  return <ManageAccountButton onOpen={() => clerk.openUserProfile()} />;
}

/** e2e only (E2E_FIXTURES): the same button without Clerk; it opens nothing. */
export function FixtureManageAccount() {
  return <ManageAccountButton onOpen={() => undefined} />;
}

function ManageAccountButton({ onOpen }: { onOpen: () => void }) {
  return (
    <Button
      variant="outline"
      className="h-auto min-h-11 px-5 py-2 whitespace-normal"
      onClick={onOpen}
    >
      Manage account
    </Button>
  );
}
