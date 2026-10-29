import type { Metadata } from 'next';
import {
  ConsentPage,
  consentReturnPath,
} from '@/components/consent/consent-page';
import { pageMetadata } from '@/lib/seo';

/** Per request: URLs come from SITE_URL (seo.ts). Never indexed: it's a step after sign-in. */
export function generateMetadata(): Metadata {
  return {
    ...pageMetadata({
      title: 'Before you use your account',
      description:
        'Two things we need before you use your He Is Real Today account.',
      path: '/consent/sign-up',
    }),
    robots: { index: false, follow: false },
  };
}

/**
 * The sign-up consent step (D73): once, after Clerk's sign-up or sign-in, for anyone who hasn't
 * accepted the sign-up form in force (the header sends them here, consent-prompts.tsx). Two
 * unticked boxes from the published form, "I am 18 or over" and "store my account and
 * favourites"; nothing is recorded until both are ticked. 18+ only, no parental route (D77).
 */
export default async function SignUpConsentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const returnTo = consentReturnPath((await searchParams)['redirect_url']);
  return (
    <ConsentPage
      form="signup"
      ask={['age_18plus', 'account_data']}
      mechanism="web_form_submission"
      title="Before you use your account"
      lead="Please read this and tick both boxes. It only takes a moment, and we’ll take you back to where you were."
      returnTo={returnTo}
    />
  );
}
