'use client';

import { ErrorReference } from '@/components/errors/error-reference';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo } from 'react';
import { useAccountState } from '@/components/auth/account-bootstrap';
import { AgreementStep } from '@/components/consent/agreement-step';
import { dismissTestimonyBanner } from '@/components/consent/consent-prompts';
import {
  Button,
  Card,
  Heading,
  Notice,
  Text,
  TextLink,
} from '@heisreal/web-ui';
import type { AgreementName } from '@/lib/legal-text';
import { personalApiUser, usePersonalSession } from '@/lib/personal-session';
import { signInHref } from '@/lib/return-path';
import { TRY_AGAIN_LATER } from '@/lib/try-again-later';

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
    <Heading level={1} className="mb-3">
      {text}
    </Heading>
  );

  if (session.status === 'signed-out') {
    const here = `${pathname}?redirect_url=${encodeURIComponent(returnTo)}`;
    return (
      <Card asChild className="p-6">
        <p>
          You’re signed out.{' '}
          <TextLink href={signInHref(here)} touch>
            Sign in to continue
          </TextLink>
        </p>
      </Card>
    );
  }
  if (account.status === 'failed') {
    return (
      <Notice kind="danger" role="alert">
        <p>{TRY_AGAIN_LATER}</p>
        <ErrorReference reference={account.reference} className="mt-1 mb-3" />
        <Button variant="outline" wrap onClick={() => window.location.reload()}>
          Try again
        </Button>
      </Notice>
    );
  }
  if (!state || !api || !userId || upToDate) {
    return (
      <div aria-busy="true" className="min-h-[16rem]">
        <Text role="status" tone="quiet">
          Loading…
        </Text>
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
            <Text tone="quiet">
              {state.agreed
                ? 'Not now? Your published stories stay up. You just can’t start a new one until you agree.'
                : 'Not now? You can read every story without agreeing. You just can’t start one until you do.'}
            </Text>
            <Button asChild variant="outline" wrap>
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
