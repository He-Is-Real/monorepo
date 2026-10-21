'use client';

import { SignInButton, SignOutButton, useUser } from '@clerk/react';
import { Button } from '@/components/ui/button';

/**
 * Sign in / sign out, and the signed-in person's name, all from Clerk in the browser (D32).
 * The name is shown, never stored: Clerk holds it (D16). Long names truncate on small phones.
 */
export function AccountControl() {
  const { isLoaded, isSignedIn, user } = useUser();

  // Same size while Clerk loads, so the header doesn't jump.
  if (!isLoaded) return <div className="h-11 w-20" aria-hidden="true" />;

  if (!isSignedIn) {
    return (
      <SignInButton mode="modal">
        <Button className="h-11 px-4">Sign in</Button>
      </SignInButton>
    );
  }

  const name =
    user.fullName || user.firstName || user.primaryEmailAddress?.emailAddress;
  return (
    <div className="flex min-w-0 items-center gap-2 text-sm">
      <span
        className="min-w-0 truncate text-secondary-text"
        data-testid="signed-in-name"
      >
        <span className="hidden sm:inline">Signed in as </span>
        <span className="text-foreground">{name}</span>
      </span>
      <SignOutButton>
        <Button variant="outline" className="h-11 shrink-0 px-4">
          Sign out
        </Button>
      </SignOutButton>
    </div>
  );
}
