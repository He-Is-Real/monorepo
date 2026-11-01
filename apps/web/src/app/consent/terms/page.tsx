import type { Metadata } from 'next';
import { AgreementShell } from '@/components/consent/agreement-shell';
import { pageMetadata } from '@/lib/seo';

/** Per request: URLs come from SITE_URL (seo.ts). Never indexed: it's a step after sign-in. */
export function generateMetadata(): Metadata {
  return {
    ...pageMetadata({
      title: 'Terms of use',
      description: 'Agree to the terms of use before you use your account.',
      path: '/consent/terms',
    }),
    robots: { index: false, follow: false },
  };
}

/**
 * The terms of use on the person's account (plan 4e; 8b P3): at sign-up, the terms and one box,
 * "I am 18 or over and agree to the terms of use" (18+ only, no parental route, D77); after the
 * terms change, what changed and "I agree". The header sends anyone not on the latest version here
 * (consent-prompts.tsx), and back afterwards: the account can't be used until then.
 */
export default function TermsAgreementPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <AgreementShell document="terms-of-use" searchParams={searchParams} />;
}
