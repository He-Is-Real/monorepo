import type { Metadata } from 'next';
import { connection } from 'next/server';
import { AdminNav } from '@/components/admin/admin-access';
import { ModerationQueue } from '@/components/moderation/moderation-queue';
import { WideColumn } from '@/components/page/page-header';
import { apiAdminUrl } from '@/lib/config';
import { pageMetadata } from '@/lib/seo';

/** Never indexed: it's for staff. */
export function generateMetadata(): Metadata {
  return {
    ...pageMetadata({
      title: 'Moderation',
      description: 'Stories waiting for review.',
      path: '/moderation',
    }),
    robots: { index: false, follow: false },
  };
}

/**
 * /moderation (M3 task 3.1, M3 plan PR 1): the stories waiting for review, oldest first, for
 * Moderators and above (D1): the page asks api-admin from the browser with the person's own token
 * (D31), and api-admin refuses anyone else; web's server renders the same shell for everyone
 * (D32) and only hands over api-admin's address.
 */
export default async function ModerationPage() {
  await connection();
  return (
    <main id="main" className="flex-1 py-10 sm:py-16">
      <WideColumn>
        <AdminNav />
        <h1 className="mb-3 text-[2rem] leading-tight font-normal text-balance sm:text-[2.5rem]">
          Moderation
        </h1>
        <p className="mb-8 max-w-measure text-[1.0625rem] text-secondary-text">
          Stories waiting for review, the one sent longest ago first. Open one
          to read, watch or listen to it as the public would, with its history.
        </p>
        <noscript>
          <p className="mb-6 rounded-2xl border border-border bg-card p-6">
            This page needs JavaScript.
          </p>
        </noscript>
        <ModerationQueue apiAdminUrl={apiAdminUrl()} />
      </WideColumn>
    </main>
  );
}
