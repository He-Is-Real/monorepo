import type { Metadata } from 'next';
import { AgreementShell } from '@/components/consent/agreement-shell';
import { pageMetadata } from '@/lib/seo';

/** Per request: URLs come from SITE_URL (seo.ts). Never indexed: it's for signed-in people. */
export function generateMetadata(): Metadata {
  return {
    ...pageMetadata({
      title: 'Testimony consent',
      description:
        'How He Is Real Today looks after your stories: read what changed and agree.',
      path: '/consent/testimony',
    }),
    robots: { index: false, follow: false },
  };
}

/**
 * The testimony consent (plan 4e), from the banner after a newer version is saved: what changed
 * since the version the person agreed to, and one tick. It covers every story they submit; their
 * published stories stay up whatever they choose, but they can't start or change one until they
 * agree (the database refuses).
 */
export default function TestimonyConsentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <AgreementShell document="testimony-consent" searchParams={searchParams} />
  );
}
