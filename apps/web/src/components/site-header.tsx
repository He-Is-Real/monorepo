import Link from 'next/link';
import { connection } from 'next/server';
import { Suspense } from 'react';
import {
  AccountControl,
  FixtureSignedInAccount,
  FixtureSignedOutAccount,
} from '@/components/auth/account-control';
import { ConsentPrompts } from '@/components/consent/consent-prompts';
import { Logo } from '@/components/logo';
import { MobileNav, NavLinks, SHARE_HREF } from '@/components/nav/site-nav';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import {
  apiUserUrl,
  clerkPublishableKey,
  e2eFixtures,
  e2eSignedInName,
} from '@/lib/config';

/**
 * The site header: home link, the main navigation, "Share your story", the theme toggle and the
 * account area. The header itself is static, in the HTML as it arrives (no JavaScript needed for
 * the navigation, no layout shift when a stream lands late). Only the account area renders per
 * request (HeaderAccount: OpenTofu sets the publishable key on the Cloud Run service; images
 * are built once for every environment), in a slot of fixed width. Without a key
 * (e.g. local dev without one) there's no sign-in control.
 *
 * Layout (mobile first, 44 px targets): the logo and the actions share the first row and the
 * actions stay right-aligned, signed in or out, whatever the name. Phones get a menu button, in
 * a row that wraps: with large text (200%) the actions move under the logo, and onto more lines
 * if they need to, rather than off the screen. From 640 px it's a three-column grid: the links
 * are a second row; from 1280 px they sit in the middle column of the first row. The header is wider than the page (up to 1440 px, like the
 * mockup's full-width nav), so that row has room.
 */
export function SiteHeader() {
  return (
    <>
      <header className="relative border-b border-border">
        <div className="mx-auto flex max-w-[90rem] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2 sm:grid sm:grid-cols-[max-content_minmax(0,1fr)_auto] sm:gap-y-0 sm:px-10">
          <Link
            href="/"
            className="col-start-1 row-start-1 inline-flex min-h-11 min-w-11 items-center justify-center gap-2 justify-self-start rounded-md text-foreground hover:text-foreground"
            aria-label="He Is Real Today, home"
          >
            <Logo size={36} />
            <span className="hidden text-sm font-semibold tracking-wide sm:inline">
              He Is Real Today
            </span>
          </Link>
          <NavLinks className="col-span-3 row-start-2 hidden sm:block sm:border-t sm:border-border xl:col-span-1 xl:col-start-2 xl:row-start-1 xl:justify-self-end xl:border-0" />
          <div
            data-header-actions=""
            className="col-start-3 row-start-1 ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1 sm:gap-2"
          >
            <Link
              href={SHARE_HREF}
              className="hidden min-h-11 items-center rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground sm:inline-flex"
            >
              Share your story
            </Link>
            <ThemeToggle />
            <div
              data-account-slot=""
              className="flex w-20 shrink-0 justify-end sm:w-44"
            >
              <Suspense fallback={ACCOUNT_PLACEHOLDER}>
                <HeaderAccount />
              </Suspense>
            </div>
            <MobileNav />
          </div>
        </div>
      </header>
      {/* After sign-in, in the browser: the sign-up step (D73) and the testimony banner (D85). */}
      <Suspense fallback={null}>
        <ConsentPrompts />
      </Suspense>
    </>
  );
}

/**
 * The account area has one width whatever it holds (this placeholder while it streams in or
 * Clerk loads, and all a visitor without JavaScript gets; "Sign in"; or the signed-in control,
 * whose name truncates to fit), so Share and the theme toggle never move when it resolves:
 * 80 px on phones (Sign in, or the avatar alone), 176 px from 640 px (avatar, first name, ▾).
 */
const ACCOUNT_PLACEHOLDER = <div className="h-11 w-20" aria-hidden="true" />;

/**
 * The account area: per request, so it reads the deployment's Clerk key and api-user's address
 * (and e2e fixtures). api-user's address is only handed to the browser (D32).
 */
async function HeaderAccount() {
  await connection();
  const publishableKey = clerkPublishableKey();
  const apiUser = apiUserUrl();
  const fixtureName = e2eSignedInName();
  // e2e: a stand-in for Clerk's control, signed out or signed in (T4; never in deployments).
  if (e2eFixtures())
    return fixtureName ? (
      <FixtureSignedInAccount name={fixtureName} apiUserUrl={apiUser} />
    ) : (
      <FixtureSignedOutAccount />
    );
  // Clerk itself is the site's one ClerkProvider (app/layout.tsx), there only with a key.
  if (!publishableKey) return null;
  return <AccountControl apiUserUrl={apiUser} />;
}
