import type { Metadata } from 'next';
import { connection } from 'next/server';
import { AdminNav } from '@/components/admin/admin-access';
import { AdminStaff } from '@/components/admin/admin-staff';
import { WideColumn } from '@/components/page/page-header';
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
    <main id="main" className="flex-1 py-10 sm:py-16">
      <WideColumn>
        <AdminNav />
        <h1 className="mb-3 text-[2rem] leading-tight font-normal text-balance sm:text-[2.5rem]">
          Staff
        </h1>
        <div className="mb-8 max-w-measure space-y-3 text-[1.0625rem] text-secondary-text">
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
        </div>
        <noscript>
          <p className="mb-6 rounded-2xl border border-border bg-card p-6">
            This page needs JavaScript.
          </p>
        </noscript>
        <AdminStaff apiAdminUrl={apiAdminUrl()} />
      </WideColumn>
    </main>
  );
}
