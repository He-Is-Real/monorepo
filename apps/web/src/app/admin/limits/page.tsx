import type { Metadata } from 'next';
import { connection } from 'next/server';
import { AdminNav } from '@/components/admin/admin-access';
import { AdminLimits } from '@/components/admin/admin-limits';
import { WideColumn } from '@/components/page/page-header';
import { apiAdminUrl } from '@/lib/config';
import { pageMetadata } from '@/lib/seo';

/** Never indexed: it's for staff. */
export function generateMetadata(): Metadata {
  return {
    ...pageMetadata({
      title: 'Submission limits',
      description: 'Change the limits everyone shares stories under.',
      path: '/admin/limits',
    }),
    robots: { index: false, follow: false },
  };
}

/**
 * /admin/limits (W3, D94, D112, D113): the submission limits everyone shares stories under, in
 * plain words with their units, and saving new ones after a confirmation. For Admin and above
 * (D1): the page asks api-admin from the browser with the person's own token (D31), and
 * api-admin refuses anyone else; web's server renders the same shell for everyone (D32) and only
 * hands over api-admin's address.
 */
export default async function AdminLimitsPage() {
  await connection();
  return (
    <main id="main" className="flex-1 py-10 sm:py-16">
      <WideColumn>
        <AdminNav />
        <h1 className="mb-3 text-[2rem] leading-tight font-normal text-balance sm:text-[2.5rem]">
          Submission limits
        </h1>
        <p className="mb-8 max-w-measure text-[1.0625rem] text-secondary-text">
          How much people can share, and how often. A change applies to everyone
          from their next step, including stories they have already started.
          Trusted submitters skip the draft, weekly and upload-count limits, and
          get the largest file sizes and lengths.
        </p>
        <noscript>
          <p className="mb-6 rounded-2xl border border-border bg-card p-6">
            This page needs JavaScript.
          </p>
        </noscript>
        <AdminLimits apiAdminUrl={apiAdminUrl()} />
      </WideColumn>
    </main>
  );
}
