import type { Metadata } from 'next';
import { connection } from 'next/server';
import { AdminNav } from '@/components/admin/admin-access';
import { ModerationList } from '@/components/moderation/moderation-list';
import { WideColumn } from '@/components/page/page-header';
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

const one = (v: string | string[] | undefined) =>
  typeof v === 'string' && v !== '' ? v : undefined;

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
 * /moderation (MD-3, MD-4: Joel 2026-11-14; it replaces the queue): every story that isn't on the
 * site, one state at a time (`?state=`), optionally one theme (`?theme=`), for Moderators and
 * Admins (Admins also see drafts never sent). The page asks api-admin from the browser with the
 * person's own token (D31), and api-admin refuses anyone else; web's server renders the same shell
 * for everyone (D32) and only hands over api-admin's address and the public themes.
 */
export default async function ModerationPage({ searchParams }: Props) {
  await connection();
  const sp = await searchParams;
  return (
    <main id="main" className="flex-1 py-10 sm:py-16">
      <WideColumn>
        <AdminNav />
        <h1 className="mb-3 text-[2rem] leading-tight font-normal text-balance sm:text-[2.5rem]">
          Moderation
        </h1>
        <p className="mb-8 max-w-measure text-[1.0625rem] text-secondary-text">
          Every story that isn’t on the site, oldest first. Open one to read,
          watch or listen to it as the public would, with its history.
        </p>
        <noscript>
          <p className="mb-6 rounded-2xl border border-border bg-card p-6">
            This page needs JavaScript.
          </p>
        </noscript>
        <ModerationList
          apiAdminUrl={apiAdminUrl()}
          categories={await themes()}
          state={one(sp['state'])}
          theme={one(sp['theme'])}
        />
      </WideColumn>
    </main>
  );
}
