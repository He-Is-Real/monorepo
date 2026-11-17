import type { Metadata } from 'next';
import { connection } from 'next/server';
import { AdminPage } from '@/components/admin/admin-page';
import { AdminConsent } from '@/components/admin/admin-consent';
import { apiAdminUrl } from '@/lib/config';
import { pageMetadata } from '@/lib/seo';

/** Never indexed: it's for staff. */
export function generateMetadata(): Metadata {
  return {
    ...pageMetadata({
      title: 'Consent & legal',
      description:
        'Save new versions of the terms of use, testimony consent, social media sharing consent and privacy notice.',
      path: '/admin/consent',
    }),
    robots: { index: false, follow: false },
  };
}

/**
 * /admin/consent (plan 4e; replaces /admin/legal): the four texts people read and agree to, and
 * saving the next version of any of them. For Admin and above (D1): the page asks api-admin from
 * the browser with the person's own token (D31), and api-admin refuses anyone else; web's server
 * renders the same shell for everyone (D32) and only hands over api-admin's address.
 */
export default async function AdminConsentPage() {
  await connection();
  return (
    <AdminPage
      title="Consent & legal"
      width="double"
      description={
        <>
          <p>
            Each text has numbered versions. Edit the latest, check what changes
            and how it will look, and save it as the next version. It’s in force
            at once, and saved versions never change.
          </p>
        </>
      }
    >
      <AdminConsent apiAdminUrl={apiAdminUrl()} />
    </AdminPage>
  );
}
