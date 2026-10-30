'use client';

import { SignOutButton, useAuth, useUser } from '@clerk/react';
import { usePathname, useSearchParams } from 'next/navigation';
import { Popover } from 'radix-ui';
import { cloneElement, type ReactElement, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { useAccountBootstrap } from '@/components/auth/account-bootstrap';
import { usePublishPersonalSession } from '@/lib/personal-session';
import { signInHref } from '@/lib/return-path';
import { forgetShareStorageExcept } from '@/lib/share-storage';

/**
 * Sign in / sign out, and the signed-in person's name, all from Clerk in the browser (D32).
 * The name is shown, never stored: Clerk holds it (D16). Once signed in, the browser calls
 * api-user's account bootstrap (`apiUserUrl`; account-bootstrap.ts); its failure changes
 * nothing here. It also tells the rest of the page who is signed in (personal-session.ts).
 */
export function AccountControl({ apiUserUrl }: { apiUserUrl?: string }) {
  const { isLoaded, isSignedIn, user } = useUser();
  const { userId, getToken } = useAuth();
  useAccountBootstrap(isSignedIn ? userId : null, apiUserUrl, () => getToken());
  // The rest of the page (hearts, My favourites) learns who is signed in from here (D83).
  usePublishPersonalSession(
    isLoaded ? (isSignedIn ? userId : null) : undefined,
    apiUserUrl,
    () => getToken(),
  );
  useForgetOthersShareStorage(isLoaded, isSignedIn ? userId : null);

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
      signOut={(button) => (
        <SignOutButton>
          {cloneElement(button as ReactElement<{ onClick?: () => void }>, {
            // Clerk's button runs this first, then signs out.
            onClick: () => forgetShareStorageExcept(null),
          })}
        </SignOutButton>
      )}
    />
  );
}

/**
 * Whenever Clerk has loaded, forget what the submit flow kept in this tab for anyone but the
 * person signed in now (everyone's when nobody is): their unsaved story text and unresolved
 * submissions (share-storage.ts). It doesn't wait to see a sign-out happen: Clerk's sign-out
 * leaves the page before reporting it, so the next page load does it. Sign out also does it
 * on the click, before Clerk signs out.
 */
function useForgetOthersShareStorage(
  isLoaded: boolean,
  userId: string | null | undefined,
) {
  useEffect(() => {
    if (!isLoaded) return;
    forgetShareStorageExcept(userId ?? null);
  }, [isLoaded, userId]);
}

/**
 * What a signed-in person sees in the header, from the design (authenticated/home-signed-in:
 * avatar, first name, ▾): a compact button no wider than the header's account slot
 * (site-header.tsx), so it never pushes the header onto a second row. The first name shows
 * from 640 px and truncates to fit; phones get the avatar only.
 * It opens a panel with the full name, My favourites and Sign out. Presentational, so the e2e suite can render
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
          <a
            href="/account/favourites"
            className="mb-2 flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm font-medium text-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <svg
              viewBox="0 0 24 24"
              aria-hidden="true"
              className="size-4 fill-none stroke-current"
              strokeWidth="2"
              strokeLinejoin="round"
            >
              <path d="M12 20.5s-7.5-4.6-9.2-9.4C1.6 7.7 3.8 4.5 7.2 4.5c2 0 3.6 1.1 4.8 2.8 1.2-1.7 2.8-2.8 4.8-2.8 3.4 0 5.6 3.2 4.4 6.6-1.7 4.8-9.2 9.4-9.2 9.4z" />
            </svg>
            My favourites
          </a>
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
/** e2e only: the fixtures' signed-in person, as Clerk's user id. */
export const E2E_FIXTURE_USER_ID = 'user_e2efixture';
/**
 * The fixture token: shaped like a session token (`header.payload.signature`, unsigned), whose
 * payload names the fixture person (`sub`, which the hearts check before sending) and, when a
 * test gives its browser one (localStorage `e2e-session`), its own session, so the stub keeps
 * that test's hearts apart from every other test's (tests run in parallel).
 */
export const e2eFixtureToken = async (): Promise<string> => {
  const stored = window.localStorage.getItem('e2e-session');
  const session = stored && /^[a-z0-9-]{1,64}$/.test(stored) ? stored : '';
  const payload = btoa(JSON.stringify({ sub: E2E_FIXTURE_USER_ID, session }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `e2e.${payload}.fixture`;
};

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
  useAccountBootstrap(E2E_FIXTURE_USER_ID, apiUserUrl, e2eFixtureToken);
  usePublishPersonalSession(E2E_FIXTURE_USER_ID, apiUserUrl, e2eFixtureToken);
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
  usePublishPersonalSession(null, undefined, e2eFixtureToken);
  return <SignInLink />;
}
