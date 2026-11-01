import type { Metadata } from 'next';
import { connection } from 'next/server';
import { AdminNav } from '@/components/admin/admin-access';
import { AdminConsent } from '@/components/admin/admin-consent';
import { WideColumn } from '@/components/page/page-header';
import { apiAdminUrl } from '@/lib/config';
import { pageMetadata } from '@/lib/seo';

/** Never indexed: it's for staff. */
export function generateMetadata(): Metadata {
  return {
    ...pageMetadata({
      title: 'Consent & legal',
      description:
        'Save new versions of the terms of use, testimony consent, social media sharing consent and privacy notice.',
      path: '/admin/consent',
    }),
    robots: { index: false, follow: false },
  };
}

/**
 * /admin/consent (plan 4e; replaces /admin/legal): the four texts people read and agree to, and
 * saving the next version of any of them. For Admin and above (D1): the page asks api-admin from
 * the browser with the person's own token (D31), and api-admin refuses anyone else; web's server
 * renders the same shell for everyone (D32) and only hands over api-admin's address.
 */
export default async function AdminConsentPage() {
  await connection();
  return (
    <main id="main" className="flex-1 py-10 sm:py-16">
      <WideColumn>
        <AdminNav />
        <h1 className="mb-3 text-[2rem] leading-tight font-normal text-balance sm:text-[2.5rem]">
          Consent &amp; legal
        </h1>
        <p className="mb-8 max-w-measure text-[1.0625rem] text-secondary-text">
          Each text has numbered versions. Edit the latest, check what changes
          and how it will look, and save it as the next version. It’s in force
          at once, and saved versions never change.
        </p>
        <noscript>
          <p className="mb-6 rounded-2xl border border-border bg-card p-6">
            This page needs JavaScript.
          </p>
        </noscript>
        <AdminConsent apiAdminUrl={apiAdminUrl()} />
      </WideColumn>
    </main>
  );
}
