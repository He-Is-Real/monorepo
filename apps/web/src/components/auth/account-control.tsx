'use client';

import { SignInButton, SignOutButton, useUser } from '@clerk/react';
import { Button } from '@/components/ui/button';

/**
 * Sign in / sign out, and the signed-in person's name, all from Clerk in the browser (D32).
 * The name is shown, never stored: Clerk holds it (D16).
 */
export function AccountControl() {
  const { isLoaded, isSignedIn, user } = useUser();

  // Same size while Clerk loads, so the header doesn't jump.
  if (!isLoaded) return <div className="h-8 w-20" aria-hidden="true" />;

  if (!isSignedIn) {
    return (
      <SignInButton mode="modal">
        <Button size="sm">Sign in</Button>
      </SignInButton>
    );
  }

  const name =
    user.fullName || user.firstName || user.primaryEmailAddress?.emailAddress;
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="text-secondary-text">
        Signed in as <span className="text-foreground">{name}</span>
      </span>
      <SignOutButton>
        <Button size="sm" variant="outline">
          Sign out
        </Button>
      </SignOutButton>
    </div>
  );
}
