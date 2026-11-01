'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo } from 'react';
import { useAccountState } from '@/components/auth/account-bootstrap';
import { AgreementStep } from '@/components/consent/agreement-step';
import { dismissTestimonyBanner } from '@/components/consent/consent-prompts';
import { Button } from '@/components/ui/button';
import type { AgreementName } from '@/lib/legal-text';
import { personalApiUser, usePersonalSession } from '@/lib/personal-session';
import { signInHref } from '@/lib/return-path';

const KEY = {
  'terms-of-use': 'termsOfUse',
  'testimony-consent': 'testimonyConsent',
} as const;

/**
 * /consent/terms and /consent/testimony (plan 4e): the signed-in person's agreement step on its
 * own page, then back to `returnTo`. Who is signed in and where they stand come from the header's
 * account bootstrap, in the browser (D32, D83); someone already on the latest version goes
 * straight on.
 */
export function AgreementPage({
  document,
  returnTo,
}: {
  document: AgreementName;
  /** A same-site path to go on to afterwards (return-path.ts). */
  returnTo: string;
}) {
  const session = usePersonalSession();
  const userId = session.status === 'signed-in' ? session.userId : null;
  const account = useAccountState(userId);
  const router = useRouter();
  const pathname = usePathname();
  const api = useMemo(
    () => (session.status === 'signed-in' ? personalApiUser(session) : null),
    [session],
  );
  const state =
    account.status === 'ready' ? account.account[KEY[document]] : null;
  const upToDate = state?.upToDate === true;

  useEffect(() => {
    if (upToDate) router.replace(returnTo);
  }, [upToDate, returnTo, router]);

  const h1 = (text: string) => (
    <h1 className="mb-3 text-[2rem] leading-tight font-normal text-balance sm:text-[2.5rem]">
      {text}
    </h1>
  );

  if (session.status === 'signed-out') {
    const here = `${pathname}?redirect_url=${encodeURIComponent(returnTo)}`;
    return (
      <p className="rounded-2xl border border-border bg-card p-6">
        You’re signed out.{' '}
        <a
          href={signInHref(here)}
          className="inline-flex min-h-11 items-center font-medium"
        >
          Sign in to continue
        </a>
      </p>
    );
  }
  if (account.status === 'failed') {
    return (
      <div
        role="alert"
        className="rounded-2xl border border-border bg-card p-6"
      >
        <p className="mb-4 text-secondary-text">
          We couldn’t load your account just now. Please try again in a moment.
        </p>
        <Button
          variant="outline"
          className="h-auto min-h-11 px-5 py-2 whitespace-normal"
          onClick={() => window.location.reload()}
        >
          Try again
        </Button>
      </div>
    );
  }
  if (!state || !api || !userId || upToDate) {
    return (
      <div aria-busy="true" className="min-h-[16rem]">
        <p role="status" className="text-secondary-text">
          Loading…
        </p>
      </div>
    );
  }
  return (
    <AgreementStep
      key={userId}
      document={document}
      agreed={state.agreed}
      userId={userId}
      api={api}
      heading={h1}
      onAgreed={() => router.replace(returnTo)}
      after={
        document === 'testimony-consent' ? (
          <section
            aria-label="Not now"
            className="mt-8 space-y-3 border-t border-border pt-6"
          >
            <p className="text-secondary-text">
              {state.agreed
                ? 'Not now? Your published stories stay up. You just can’t start a new one until you agree.'
                : 'Not now? You can read every story without agreeing. You just can’t start one until you do.'}
            </p>
            <Button
              asChild
              variant="outline"
              className="h-auto min-h-11 max-w-full shrink px-6 py-2 whitespace-normal"
            >
              <Link href={returnTo} onClick={dismissTestimonyBanner}>
                Not now
              </Link>
            </Button>
          </section>
        ) : null
      }
    />
  );
}
