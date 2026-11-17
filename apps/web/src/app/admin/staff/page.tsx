import type { Metadata } from 'next';
import { connection } from 'next/server';
import { AdminPage } from '@/components/admin/admin-page';
import { AdminStaff } from '@/components/admin/admin-staff';
import { apiAdminUrl } from '@/lib/config';
import { pageMetadata } from '@/lib/seo';

/** Never indexed: it's for staff. */
export function generateMetadata(): Metadata {
  return {
    ...pageMetadata({
      title: 'Staff',
      description: 'Who the moderators and admins are.',
      path: '/admin/staff',
    }),
    robots: { index: false, follow: false },
  };
}

/**
 * /admin/staff (S-1 to S-4, G7, G8 B, G24; Joel 2026-11-11): the staff list, and adding,
 * changing and removing Moderators and Admins. For Admins only (D1): the page asks api-admin from
 * the browser with the person's own token (D31), and api-admin refuses anyone else; web's server
 * renders the same shell for everyone (D32) and only hands over api-admin's address.
 */
export default async function AdminStaffPage() {
  await connection();
  return (
    <AdminPage
      title="Staff"
      description={
        <>
          <p>
            Moderators review the stories waiting for review. Admins can do that
            too, and also change themes, limits and legal texts, and who is
            staff.
          </p>
          <p>
            A change takes effect within about a minute, when the person’s
            sign-in next refreshes.
          </p>
          <p>
            Baseline admins come back as admins on the next deploy (or sooner,
            when the admin service restarts) if they are removed or their role
            is changed here, so we can’t lock ourselves out.
          </p>
        </>
      }
    >
      <AdminStaff apiAdminUrl={apiAdminUrl()} />
    </AdminPage>
  );
}
