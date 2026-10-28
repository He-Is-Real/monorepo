import type { Metadata } from 'next';
import {
  ConsentPage,
  consentReturnPath,
} from '@/components/consent/consent-page';
import { pageMetadata } from '@/lib/seo';

/** Per request: URLs come from SITE_URL (seo.ts). Never indexed: it's for signed-in people. */
export function generateMetadata(): Metadata {
  return {
    ...pageMetadata({
      title: 'Your story and your data',
      description:
        'The updated form about how He Is Real Today looks after your story.',
      path: '/consent/testimony',
    }),
    robots: { index: false, follow: false },
  };
}

/**
 * A newer testimony form (D85), from the banner after sign-in: accepting it moves the person's
 * account to the version in force (their Art 9 grant on it, `special_category_religious`),
 * which covers their earlier stories too. Publishing is asked again when they next submit
 * (D67), so it is shown as words here, not a box. It only gates new drafts and submissions
 * (D93): their stories stay up whatever they choose.
 */
export default async function TestimonyConsentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const returnTo = consentReturnPath((await searchParams)['redirect_url']);
  return (
    <ConsentPage
      form="testimony"
      ask={['special_category_religious']}
      mechanism="reconsent_prompt"
      title="Your story and your data"
      lead="We’ve updated this form. Please read it and tick the box before you start or submit a new story. Your stories stay on the site whatever you choose."
      returnTo={returnTo}
    />
  );
}
