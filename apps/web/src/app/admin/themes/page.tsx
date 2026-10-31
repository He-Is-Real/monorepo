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
      description: 'Change the themes people choose from and browse by.',
      path: '/admin/themes',
    }),
    robots: { index: false, follow: false },
  };
}

/**
 * /admin/themes (themes plan v3): the categories and themes people choose from when they share
 * a story and browse by. For Admin and above (D1): the page asks api-admin from the browser with
 * the person's own token (D31), and api-admin refuses anyone else; web's server renders the same
 * shell for everyone (D32) and only hands over api-admin's address.
 */
export default async function AdminThemesPage() {
  await connection();
  return (
    <main id="main" className="flex-1 pt-10 sm:pt-16">
      <WideColumn>
        <AdminNav />
        <h1 className="mb-3 text-[2rem] leading-tight font-normal text-balance sm:text-[2.5rem]">
          Themes
        </h1>
        <p className="mb-8 max-w-measure text-[1.0625rem] text-secondary-text">
          Themes in a category’s Highlighted section are shown first everywhere.
          Drag a theme in or out of Highlighted or to another category, click
          its name to edit it, or press × to delete it. On a phone or with a
          keyboard, open a theme to change it. Nothing is stored until you press
          Save changes.
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
