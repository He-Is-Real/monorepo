import type { Metadata } from 'next';
import Link from 'next/link';
import { connection } from 'next/server';
import { AdminPage } from '@/components/admin/admin-page';
import { ModerationReview } from '@/components/moderation/moderation-review';
import { apiAdminUrl } from '@/lib/config';
import { pageMetadata } from '@/lib/seo';

type Props = { params: Promise<{ id: string }> };

/** Never indexed: it's for staff, and the story isn't public. */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  return {
    ...pageMetadata({
      title: 'Review a story',
      description: 'A story for moderators.',
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
    <AdminPage
      width="story"
      header={
        <p className="mb-6">
          <Link
            href="/moderation"
            className="inline-flex min-h-11 items-center"
          >
            ← Back to the list
          </Link>
        </p>
      }
    >
      <ModerationReview id={id} apiAdminUrl={apiAdminUrl()} />
    </AdminPage>
  );
}
