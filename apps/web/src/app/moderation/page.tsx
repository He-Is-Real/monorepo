import type { Metadata } from 'next';
import { connection } from 'next/server';
import { AdminPage } from '@/components/admin/admin-page';
import { listFilters } from '@/components/moderation/moderation-api';
import { ModerationList } from '@/components/moderation/moderation-list';
import { listThemes, type ThemeCategory } from '@/lib/browse';
import { apiAdminUrl } from '@/lib/config';
import { StoriesUnavailableError } from '@/lib/public-stories';
import { pageMetadata } from '@/lib/seo';

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/** Never indexed: it's for staff. */
export function generateMetadata(): Metadata {
  return {
    ...pageMetadata({
      title: 'Moderation',
      description: 'Stories that aren’t on the site.',
      path: '/moderation',
    }),
    robots: { index: false, follow: false },
  };
}

/** The themes to filter by, as browse lists them; none if api-public-read can't answer. */
async function themes(): Promise<ThemeCategory[]> {
  try {
    return await listThemes();
  } catch (err) {
    if (err instanceof StoriesUnavailableError) return [];
    throw err;
  }
}

/**
 * /moderation (MD-3, MD-4: Joel 2026-11-14; it replaces the queue; MQ-1 E, Joel 2026-11-17): every
 * story that isn't on the site, one state at a time (`?state=`), narrowed by a title search
 * (`?q=`), one format (`?format=`) and stacked themes (`?theme=`, repeated; BS-7), filtered as browse filters (revised
 * OQ-2, Joel 2026-11-19), and sorted (`?sort=`), for Moderators and Admins (Admins also see
 * drafts never sent). Wider than the site on big screens (OQ-3 A), centred (OQ-4 D). The page
 * asks api-admin from the browser with the person's own token (D31), and api-admin refuses anyone else; web's server renders the same shell
 * for everyone (D32) and only hands over api-admin's address and the public themes.
 */
export default async function ModerationPage({ searchParams }: Props) {
  await connection();
  const sp = await searchParams;
  return (
    <AdminPage
      width="wide"
      title="Moderation"
      description={
        <>
          <p>
            Every story that isn’t on the site. Open one to read, watch or
            listen to it as the public would, with its history.
          </p>
        </>
      }
    >
      <ModerationList
        apiAdminUrl={apiAdminUrl()}
        categories={await themes()}
        filters={listFilters(sp)}
      />
    </AdminPage>
  );
}
