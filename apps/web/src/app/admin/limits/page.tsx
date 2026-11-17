import type { Metadata } from 'next';
import { connection } from 'next/server';
import { AdminPage } from '@/components/admin/admin-page';
import { AdminLimits } from '@/components/admin/admin-limits';
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
 * hands over api-admin's address. The page uses the site's full content width (SL-1 C, Joel
 * 2026-11-17): the groups down the side, one group's limits beside them.
 */
export default async function AdminLimitsPage() {
  await connection();
  return (
    <AdminPage
      title="Submission limits"
      width="site"
      description={
        <>
          <p>
            How much people can share and how often; a change applies to
            everyone from their next step, including stories they have already
            started.
          </p>
        </>
      }
    >
      <AdminLimits apiAdminUrl={apiAdminUrl()} />
    </AdminPage>
  );
}
