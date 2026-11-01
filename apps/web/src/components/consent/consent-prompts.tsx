'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useSyncExternalStore } from 'react';
import { useAccountState } from '@/components/auth/account-bootstrap';
import { Button } from '@/components/ui/button';
import { safeReturnPath, SIGN_IN_PATH } from '@/lib/return-path';

/** The terms of use on the person's account: at sign-up, and after the terms change (plan 4e). */
export const TERMS_AGREEMENT_PATH = '/consent/terms';
/** The testimony consent after a newer version is saved (plan 4e, the banner's step). */
export const TESTIMONY_CONSENT_PATH = '/consent/testimony';

/**
 * Pages a person who hasn't agreed to the latest terms of use may stay on: the step itself,
 * sign-in, and the privacy notice and terms they may want to read first (with their numbered
 * versions).
 */
const OPEN_BEFORE_TERMS = [
  TERMS_AGREEMENT_PATH,
  SIGN_IN_PATH,
  '/privacy',
  '/terms',
];
/** `/privacy/versions/3`, `/terms/versions/0`: one numbered version, nothing else. */
const LEGAL_DOCUMENT_VERSION =
  /^\/(privacy|terms)\/versions\/(0|[1-9][0-9]{0,8})$/;

/** `path` with `redirect_url` set to where the person is now. */
export function withReturn(path: string, here: string): string {
  const back = safeReturnPath(here);
  return back === '/'
    ? path
    : `${path}?redirect_url=${encodeURIComponent(back)}`;
}

// "Not now" on the banner lasts for this page load only (nothing is stored in the browser): the
// next page load asks again, as long as the account still needs it.
let bannerDismissed = false;
const listeners = new Set<() => void>();
export function dismissTestimonyBanner(): void {
  bannerDismissed = true;
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/**
 * The agreement prompts after sign-in (plan 4e), from what the header's account bootstrap found
 * (account-bootstrap.ts); all in the browser, since web's server never knows who is signed in
 * (D32, D83).
 *
 * - **The terms of use:** someone who hasn't agreed to the latest version (a new account, or the
 *   terms changed since) is taken to the step (`/consent/terms`), and back to this page afterwards.
 *   Until then the site is theirs to read, but not to use signed in: the database refuses their
 *   hearts and stories.
 * - **The banner:** someone who agreed to an older testimony consent than the latest is asked to
 *   read what changed and agree again (`/consent/testimony`). It only gates starting or changing a
 *   story: their published stories stay up whatever they choose. Someone who has never agreed is
 *   asked when they start their first story, not here.
 *
 * If the bootstrap failed or hasn't answered, nothing happens: it blocks nothing.
 */
export function ConsentPrompts() {
  const account = useAccountState();
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const router = useRouter();
  const dismissed = useSyncExternalStore(
    subscribe,
    () => bannerDismissed,
    () => false,
  );
  const here = `${pathname}${search ? `?${search}` : ''}`;

  const needsTerms =
    account.status === 'ready' &&
    !account.account.termsOfUse.upToDate &&
    !OPEN_BEFORE_TERMS.includes(pathname) &&
    !LEGAL_DOCUMENT_VERSION.test(pathname);
  useEffect(() => {
    if (needsTerms) router.replace(withReturn(TERMS_AGREEMENT_PATH, here));
  }, [needsTerms, here, router]);

  const showBanner =
    account.status === 'ready' &&
    account.account.termsOfUse.upToDate &&
    account.account.testimonyConsent.upToDate === false &&
    account.account.testimonyConsent.agreed !== null &&
    !dismissed &&
    pathname !== TESTIMONY_CONSENT_PATH &&
    pathname !== '/share';
  if (!showBanner) return null;

  return (
    <section
      aria-labelledby="consent-banner-title"
      data-consent-banner=""
      className="border-b border-border bg-surface"
    >
      <div className="mx-auto flex max-w-[90rem] flex-wrap items-center gap-x-6 gap-y-3 px-4 py-4 sm:px-10">
        <div className="min-w-0 flex-[1_1_20rem]">
          <h2
            id="consent-banner-title"
            className="text-base font-semibold text-foreground"
          >
            Our testimony consent has changed
          </h2>
          <p className="text-sm text-secondary-text">
            Please read what’s changed and agree before you start or change a
            story. Your published stories stay up either way.
          </p>
        </div>
        <div className="flex min-w-0 max-w-full flex-wrap gap-2">
          <Button
            asChild
            className="h-auto min-h-11 max-w-full shrink px-5 py-2 whitespace-normal"
          >
            <Link href={withReturn(TESTIMONY_CONSENT_PATH, here)}>
              Read what’s changed
            </Link>
          </Button>
          <Button
            variant="outline"
            className="h-auto min-h-11 max-w-full shrink px-5 py-2 whitespace-normal"
            onClick={dismissTestimonyBanner}
          >
            Not now
          </Button>
        </div>
      </div>
    </section>
  );
}
