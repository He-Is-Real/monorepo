'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useSyncExternalStore } from 'react';
import { useAccountState } from '@/components/auth/account-bootstrap';
import { Button } from '@/components/ui/button';
import { safeReturnPath, SIGN_IN_PATH } from '@/lib/return-path';

/** The sign-up consent step (D73). */
export const SIGN_UP_CONSENT_PATH = '/consent/sign-up';
/** The page that asks for a newer testimony form (D85). */
export const TESTIMONY_CONSENT_PATH = '/consent/testimony';

/**
 * Pages a person who hasn't accepted the sign-up form may stay on: the step itself, sign-in,
 * the legal pages they may want to read first, and the staff page that publishes those
 * documents (D121). In a new environment nothing is published yet, so the step can't be
 * completed until an Admin publishes there; api-admin still refuses anyone below Admin.
 */
const OPEN_BEFORE_SIGN_UP_CONSENT = [
  SIGN_UP_CONSENT_PATH,
  SIGN_IN_PATH,
  '/privacy',
  '/terms',
  '/admin/legal',
];

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
 * The consent prompts after sign-in, from what the header's account bootstrap found
 * (account-bootstrap.ts); all in the browser, since web's server never knows who is signed in
 * (D32, D83).
 *
 * - **D73, the sign-up step:** someone whose sign-up consent isn't accepted on the version in
 *   force is taken to it (`/consent/sign-up`), and back to this page afterwards. Until then the
 *   site is theirs to read, but not to use signed in.
 * - **D85, the banner:** someone on a testimony version that a newer one, requiring acceptance
 *   for new submissions, replaced is asked to read and accept it. It gates only new drafts and
 *   submissions (D93): their stories stay up whatever they choose, and nothing else is blocked.
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

  const needsSignUpConsent =
    account.status === 'ready' &&
    !account.account.signupConsent.accepted &&
    !OPEN_BEFORE_SIGN_UP_CONSENT.includes(pathname);
  useEffect(() => {
    if (needsSignUpConsent)
      router.replace(withReturn(SIGN_UP_CONSENT_PATH, here));
  }, [needsSignUpConsent, here, router]);

  const showBanner =
    account.status === 'ready' &&
    account.account.signupConsent.accepted &&
    account.account.testimonyConsent.acceptanceRequired &&
    !dismissed &&
    pathname !== TESTIMONY_CONSENT_PATH;
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
            We’ve updated “Your story and your data”
          </h2>
          <p className="text-sm text-secondary-text">
            Please read and accept it before you start or submit a new story.
            Your stories stay on the site either way.
          </p>
        </div>
        <div className="flex min-w-0 max-w-full flex-wrap gap-2">
          <Button
            asChild
            className="h-auto min-h-11 max-w-full shrink px-5 py-2 whitespace-normal"
          >
            <Link href={withReturn(TESTIMONY_CONSENT_PATH, here)}>
              Read and accept
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
