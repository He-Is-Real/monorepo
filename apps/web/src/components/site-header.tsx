import Link from 'next/link';
import { connection } from 'next/server';
import { AccountControl } from '@/components/auth/account-control';
import { ClerkBrowser } from '@/components/auth/clerk-browser';
import { Logo } from '@/components/logo';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { clerkPublishableKey } from '@/lib/config';

/**
 * The site header: home link, theme toggle and the account area. The publishable key is read
 * at request time (Terraform sets it on the Cloud Run service; images are built once for every
 * environment), so this renders per request. Without a key (e.g. local dev without one) there's
 * no sign-in control. Mobile first: one row from 320 px up, 44 px targets.
 */
export async function SiteHeader() {
  await connection();
  const publishableKey = clerkPublishableKey();
  return (
    <header className="border-b border-border">
      <div className="mx-auto flex max-w-site items-center justify-between gap-2 px-4 py-2 sm:px-10">
        <Link
          href="/"
          className="inline-flex min-h-11 items-center gap-2 rounded-md text-foreground hover:text-foreground"
          aria-label="He Is Real Today, home"
        >
          <Logo size={36} />
          <span className="hidden text-sm font-semibold tracking-wide sm:inline">
            He Is Real Today
          </span>
        </Link>
        <div className="flex min-w-0 items-center gap-1 sm:gap-2">
          <ThemeToggle />
          {publishableKey ? (
            <ClerkBrowser publishableKey={publishableKey}>
              <AccountControl />
            </ClerkBrowser>
          ) : null}
        </div>
      </div>
    </header>
  );
}
