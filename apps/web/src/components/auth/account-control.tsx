'use client';

import { SignOutButton, useAuth, useUser } from '@clerk/react';
import { usePathname, useSearchParams } from 'next/navigation';
import { Popover } from 'radix-ui';
import { Button } from '@/components/ui/button';
import { useAccountBootstrap } from '@/components/auth/account-bootstrap';
import { signInHref } from '@/lib/return-path';

/**
 * Sign in / sign out, and the signed-in person's name, all from Clerk in the browser (D32).
 * The name is shown, never stored: Clerk holds it (D16). Once signed in, the browser calls
 * api-user's account bootstrap (`apiUserUrl`; account-bootstrap.ts); its failure changes
 * nothing here.
 */
export function AccountControl({ apiUserUrl }: { apiUserUrl?: string }) {
  const { isLoaded, isSignedIn, user } = useUser();
  const { userId, getToken } = useAuth();
  useAccountBootstrap(isSignedIn ? userId : null, apiUserUrl, () => getToken());

  // Same size while Clerk loads, so the header doesn't jump.
  if (!isLoaded) return <div className="h-11 w-20" aria-hidden="true" />;

  if (!isSignedIn) return <SignInLink />;

  const name =
    user.fullName ||
    user.firstName ||
    user.primaryEmailAddress?.emailAddress ||
    '';
  return (
    <SignedInAccount
      name={name}
      shortName={user.firstName || name}
      signOut={(button) => <SignOutButton>{button}</SignOutButton>}
    />
  );
}

/**
 * What a signed-in person sees in the header, from the design (authenticated/home-signed-in:
 * avatar, first name, ▾): a compact button no wider than the header's account slot
 * (site-header.tsx), so it never pushes the header onto a second row. The first name shows
 * from 640 px and truncates to fit; phones get the avatar only.
 * It opens a panel with the full name and Sign out. Presentational, so the e2e suite can render
 * it without a Clerk session (site-header.tsx, E2E_FIXTURES). `signOut` wraps the Sign out
 * button (Clerk's SignOutButton in the app).
 */
export function SignedInAccount({
  name,
  shortName = name,
  signOut,
}: {
  name: string;
  shortName?: string;
  signOut: (button: React.ReactElement) => React.ReactNode;
}) {
  const initial = [...name.trim()][0]?.toUpperCase() ?? '?';
  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label={`Account: ${name}`}
        className="inline-flex min-h-11 min-w-11 max-w-full items-center justify-center gap-2 rounded-lg px-1 text-sm text-secondary-text transition-colors hover:bg-accent hover:text-foreground data-[state=open]:bg-accent sm:pr-2"
      >
        <span
          aria-hidden="true"
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground"
        >
          {initial}
        </span>
        <span
          aria-hidden="true"
          className="hidden min-w-0 truncate font-medium text-foreground sm:inline"
        >
          {shortName}
        </span>
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          className="hidden size-4 shrink-0 fill-none stroke-current sm:block"
          strokeWidth="2"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="end"
          sideOffset={8}
          collisionPadding={16}
          aria-label="Account"
          className="z-50 max-h-[var(--radix-popover-content-available-height)] w-64 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-2xl border border-border-hover bg-card p-4 text-card-foreground shadow-2xl outline-none data-[state=open]:animate-in data-[state=open]:fade-in data-[state=open]:zoom-in-95"
        >
          <p className="mb-3 text-sm text-secondary-text [overflow-wrap:anywhere]">
            Signed in as{' '}
            <span className="font-medium text-foreground">{name}</span>
          </p>
          {signOut(
            <Button variant="outline" className="h-11 w-full">
              Sign out
            </Button>,
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * "Sign in": a link to the sign-in page, which returns the person to this page afterwards.
 * A plain link (a full page load), so the sign-in page's Clerk starts afresh.
 */
export function SignInLink() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  return (
    <Button asChild className="h-11 px-4">
      <a href={signInHref(`${pathname}${search ? `?${search}` : ''}`)}>
        Sign in
      </a>
    </Button>
  );
}

/**
 * e2e only: the session token the fixtures send to the stub api-user (apps/web/e2e), which
 * accepts nothing else. Not a Clerk token; deployed sites never use the fixtures.
 */
export const E2E_FIXTURE_TOKEN = 'e2e-fixture-session-token';
const fixtureToken = async () => E2E_FIXTURE_TOKEN;

/**
 * e2e fixture (E2E_FIXTURES): the signed-in header without Clerk; Sign out does nothing. It
 * calls the account bootstrap like the real one, with the fixture token.
 */
export function FixtureSignedInAccount({
  name,
  apiUserUrl,
}: {
  name: string;
  apiUserUrl?: string;
}) {
  useAccountBootstrap('user_e2efixture', apiUserUrl, fixtureToken);
  return (
    <SignedInAccount
      name={name}
      shortName={name.split(' ')[0]}
      signOut={(button) => button}
    />
  );
}

/** e2e fixture (E2E_FIXTURES): the signed-out control, without Clerk. */
export function FixtureSignedOutAccount() {
  return <SignInLink />;
}
