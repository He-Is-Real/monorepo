import type { Metadata } from 'next';
import { connection } from 'next/server';
import { AdminHome } from '@/components/admin/admin-home';
import { AdminPage } from '@/components/admin/admin-page';
import { apiAdminUrl } from '@/lib/config';
import { pageMetadata } from '@/lib/seo';

/** Never indexed: it's for staff. */
export function generateMetadata(): Metadata {
  return {
    ...pageMetadata({
      title: 'Admin',
      description: 'The staff pages.',
      path: '/admin',
    }),
    robots: { index: false, follow: false },
  };
}

/**
 * /admin (Joel, 2026-11-20): where the site navigation's "Admin" link leads. The shared admin
 * header with the staff menu for the person's role, no page in it chosen, and nothing else. For
 * Moderators and up, refused to anyone else like the moderation pages (D1); web's server renders
 * the same shell for everyone (D32) and only hands over api-admin's address.
 */
export default async function AdminHomePage() {
  await connection();
  return (
    <AdminPage
      title="Admin"
      description={<p>Choose what to work on from the pages above.</p>}
    >
      <AdminHome apiAdminUrl={apiAdminUrl()} />
    </AdminPage>
  );
}
