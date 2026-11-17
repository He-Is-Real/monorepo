import type { Metadata } from 'next';
import { connection } from 'next/server';
import { AdminPage } from '@/components/admin/admin-page';
import { AdminBlockList } from '@/components/admin/admin-block-list';
import { apiAdminUrl } from '@/lib/config';
import { pageMetadata } from '@/lib/seo';

/** Never indexed: it's for staff. */
export function generateMetadata(): Metadata {
  return {
    ...pageMetadata({
      title: 'Block list',
      description: 'Blocked email and IP addresses.',
      path: '/admin/block-list',
    }),
    robots: { index: false, follow: false },
  };
}

/**
 * /admin/block-list (G21 D, G24; Joel 2026-11-11): the blocked emails and IP addresses, and
 * adding and removing them. For Admins only (D1): the page asks api-admin from the browser with
 * the person's own token (D31), and api-admin refuses anyone else; web's server renders the same
 * shell for everyone (D32) and only hands over api-admin's address. `?ip=` fills in an address
 * to block, from a story's moderation view.
 */
export default async function AdminBlockListPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const { ip } = await searchParams;
  return (
    <AdminPage
      title="Block list"
      description={
        <>
          <p>
            Block someone who breaks our terms of use. A blocked email can’t
            create an account or send a story; a blocked IP address can’t send a
            story. Anyone can still read the site.
          </p>
          <p>
            A block stays until you remove it, even if the account is deleted.
          </p>
        </>
      }
    >
      <AdminBlockList
        apiAdminUrl={apiAdminUrl()}
        initialIp={typeof ip === 'string' ? ip.slice(0, 45) : undefined}
      />
    </AdminPage>
  );
}
