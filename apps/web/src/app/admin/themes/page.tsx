import type { Metadata } from 'next';
import { connection } from 'next/server';
import { AdminNav } from '@/components/admin/admin-access';
import { AdminThemes } from '@/components/admin/admin-themes';
import { WideColumn } from '@/components/page/page-header';
import { apiAdminUrl } from '@/lib/config';
import { pageMetadata } from '@/lib/seo';

/** Never indexed: it's for staff. */
export function generateMetadata(): Metadata {
  return {
    ...pageMetadata({
      title: 'Themes',
      description: 'Add and rename themes, and choose the main ones.',
      path: '/admin/themes',
    }),
    robots: { index: false, follow: false },
  };
}

/**
 * /admin/themes (O5, Joel 2026-10-31): add a theme, rename one (never delete), and choose the main
 * themes people see first, their order and how many. For Admin and above (D1): the page asks
 * api-admin from the browser with the person's own token (D31), and api-admin refuses anyone
 * else; web's server renders the same shell for everyone (D32) and only hands over api-admin's
 * address.
 */
export default async function AdminThemesPage() {
  await connection();
  return (
    <main id="main" className="flex-1 py-10 sm:py-16">
      <WideColumn>
        <AdminNav />
        <h1 className="mb-3 text-[2rem] leading-tight font-normal text-balance sm:text-[2.5rem]">
          Themes
        </h1>
        <p className="mb-8 max-w-measure text-[1.0625rem] text-secondary-text">
          The themes people choose for their stories and browse by.
        </p>
        <noscript>
          <p className="mb-6 rounded-2xl border border-border bg-card p-6">
            This page needs JavaScript.
          </p>
        </noscript>
        <AdminThemes apiAdminUrl={apiAdminUrl()} />
      </WideColumn>
    </main>
  );
}
