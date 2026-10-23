import Link from 'next/link';
import { connection } from 'next/server';
import { AccountControl } from '@/components/auth/account-control';
import { ClerkBrowser } from '@/components/auth/clerk-browser';
import { Logo } from '@/components/logo';
import { MobileNav, NavLinks, SHARE_HREF } from '@/components/nav/site-nav';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { clerkPublishableKey } from '@/lib/config';

/**
 * The site header: home link, the main navigation, "Share your story", the theme toggle and the
 * account area. The publishable key is read at request time (OpenTofu sets it on the Cloud Run
 * service; images are built once for every environment), so this renders per request. Without
 * a key (e.g. local dev without one) there's no sign-in control. Mobile first, 44 px targets:
 * phones get a menu button; from 640 px the links are a second row, and one row from 1280 px.
 */
export async function SiteHeader() {
  await connection();
  const publishableKey = clerkPublishableKey();
  return (
    <header className="relative border-b border-border">
      <div className="mx-auto flex max-w-site flex-wrap items-center gap-x-4 px-4 py-2 sm:px-10">
        <Link
          href="/"
          className="inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-md text-foreground hover:text-foreground"
          aria-label="He Is Real Today, home"
        >
          <Logo size={36} />
          <span className="hidden text-sm font-semibold tracking-wide sm:inline">
            He Is Real Today
          </span>
        </Link>
        <NavLinks className="hidden sm:order-last sm:block sm:w-full sm:border-t sm:border-border xl:order-none xl:ml-auto xl:w-auto xl:border-0" />
        <div className="ml-auto flex min-w-0 items-center gap-1 sm:gap-2 xl:ml-0">
          <Link
            href={SHARE_HREF}
            className="hidden min-h-11 items-center rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground sm:inline-flex"
          >
            Share your story
          </Link>
          <ThemeToggle />
          {publishableKey ? (
            <ClerkBrowser publishableKey={publishableKey}>
              <AccountControl />
            </ClerkBrowser>
          ) : null}
          <MobileNav />
        </div>
      </div>
    </header>
  );
}
