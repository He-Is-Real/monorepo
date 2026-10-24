import Link from 'next/link';
import { connection } from 'next/server';
import { Suspense } from 'react';
import {
  AccountControl,
  FixtureSignedInAccount,
} from '@/components/auth/account-control';
import { ClerkBrowser } from '@/components/auth/clerk-browser';
import { Logo } from '@/components/logo';
import { MobileNav, NavLinks, SHARE_HREF } from '@/components/nav/site-nav';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { clerkPublishableKey, e2eSignedInName } from '@/lib/config';

/**
 * The site header: home link, the main navigation, "Share your story", the theme toggle and the
 * account area. The header itself is static, in the HTML as it arrives (no JavaScript needed for
 * the navigation, no layout shift when a stream lands late). Only the account area renders per
 * request (HeaderAccount: OpenTofu sets the publishable key on the Cloud Run service; images
 * are built once for every environment), behind a placeholder of the same size. Without a key
 * (e.g. local dev without one) there's no sign-in control.
 *
 * Layout (mobile first, 44 px targets): a three-column grid, so the logo and the actions always
 * share the first row and the actions stay right-aligned, signed in or out, whatever the name.
 * Phones get a menu button; from 640 px the links are a second row; from 1280 px they sit in the
 * middle column of the first row. The header is wider than the page (up to 1440 px, like the
 * mockup's full-width nav), so that row has room.
 */
export function SiteHeader() {
  return (
    <header className="relative border-b border-border">
      <div className="mx-auto grid max-w-[90rem] grid-cols-[max-content_minmax(0,1fr)_auto] items-center gap-x-4 px-4 py-2 sm:px-10">
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
          className="col-start-3 row-start-1 flex min-w-0 items-center justify-end gap-1 sm:gap-2"
        >
          <Link
            href={SHARE_HREF}
            className="hidden min-h-11 items-center rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground sm:inline-flex"
          >
            Share your story
          </Link>
          <ThemeToggle />
          <Suspense fallback={ACCOUNT_PLACEHOLDER}>
            <HeaderAccount />
          </Suspense>
          <MobileNav />
        </div>
      </div>
    </header>
  );
}

/** The account control's size while it streams in or Clerk loads (AccountControl's own). */
const ACCOUNT_PLACEHOLDER = <div className="h-11 w-20" aria-hidden="true" />;

/** The account area: per request, so it reads the deployment's Clerk key (and e2e fixtures). */
async function HeaderAccount() {
  await connection();
  const publishableKey = clerkPublishableKey();
  const fixtureName = e2eSignedInName();
  if (fixtureName) return <FixtureSignedInAccount name={fixtureName} />;
  if (!publishableKey) return null;
  return (
    <ClerkBrowser publishableKey={publishableKey}>
      <AccountControl />
    </ClerkBrowser>
  );
}
