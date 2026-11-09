import type { Metadata } from 'next';
import Link from 'next/link';
import { connection } from 'next/server';
import { AdminNav } from '@/components/admin/admin-access';
import { ModerationReview } from '@/components/moderation/moderation-review';
import { WideColumn } from '@/components/page/page-header';
import { apiAdminUrl } from '@/lib/config';
import { pageMetadata } from '@/lib/seo';

type Props = { params: Promise<{ id: string }> };

/** Never indexed: it's for staff, and the story isn't public. */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  return {
    ...pageMetadata({
      title: 'Review a story',
      description: 'A story waiting for review.',
      path: `/moderation/${encodeURIComponent(id)}`,
    }),
    robots: { index: false, follow: false },
  };
}

/**
 * /moderation/{id} (M3 task 3.2, M3 plan PR 1): one story under review, read-only, for
 * Moderators and above. Like /moderation, web's server sends the same shell to everyone (D32);
 * the browser asks api-admin with the person's own token (D31).
 */
export default async function ModerationReviewPage({ params }: Props) {
  await connection();
  const { id } = await params;
  return (
    <main id="main" className="flex-1 py-10 sm:py-16">
      <WideColumn>
        <AdminNav />
        <p className="mb-6">
          <Link
            href="/moderation"
            className="inline-flex min-h-11 items-center"
          >
            ← Back to the queue
          </Link>
        </p>
      </WideColumn>
      {/* As the story page: the article sets its own widths inside the page's padding. */}
      <div className="px-4 sm:px-10">
        <div className="mx-auto w-full max-w-narrow">
          <noscript>
            <p className="mb-6 rounded-2xl border border-border bg-card p-6">
              This page needs JavaScript.
            </p>
          </noscript>
          <ModerationReview id={id} apiAdminUrl={apiAdminUrl()} />
        </div>
      </div>
    </main>
  );
}
