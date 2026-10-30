import type { Metadata } from 'next';
import { connection } from 'next/server';
import { AdminLegal } from '@/components/admin/admin-legal';
import { WideColumn } from '@/components/page/page-header';
import { apiAdminUrl } from '@/lib/config';
import { pageMetadata } from '@/lib/seo';

/** Never indexed: it's for staff. */
export function generateMetadata(): Metadata {
  return {
    ...pageMetadata({
      title: 'Legal documents',
      description:
        'Publish new versions of the privacy policy and terms of use.',
      path: '/admin/legal',
    }),
    robots: { index: false, follow: false },
  };
}

/**
 * /admin/legal (D121, D123): the privacy policy's and the terms of use's versions, and
 * publishing a new one (the first one too) with its PDF of record and its web text. For Admin and above (D1): the page asks api-admin from the
 * browser with the person's own token (D31), and api-admin refuses anyone else; web's server
 * renders the same shell for everyone (D32) and only hands over api-admin's address.
 */
export default async function AdminLegalPage() {
  await connection();
  return (
    <main id="main" className="flex-1 py-10 sm:py-16">
      <WideColumn>
        <h1 className="mb-3 text-[2rem] leading-tight font-normal text-balance sm:text-[2.5rem]">
          Legal documents
        </h1>
        <p className="mb-8 max-w-measure text-[1.0625rem] text-secondary-text">
          The privacy policy and the terms of use each have their own versions.
          Publish a new one with its PDF and the words the site shows; earlier
          versions stay here, unchanged, for ever.
        </p>
        <noscript>
          <p className="mb-6 rounded-2xl border border-border bg-card p-6">
            This page needs JavaScript.
          </p>
        </noscript>
        <AdminLegal apiAdminUrl={apiAdminUrl()} />
      </WideColumn>
    </main>
  );
}
