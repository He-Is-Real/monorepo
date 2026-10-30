import type { Metadata } from 'next';
import { connection } from 'next/server';
import { NarrowColumn, PageHeader } from '@/components/page/page-header';
import {
  ShareWithClerk,
  ShareWithFixture,
} from '@/components/share/share-client';
import {
  apiUserUrl,
  clerkPublishableKey,
  e2eFixtures,
  e2eSignedInName,
} from '@/lib/config';
import { getShareLegal } from '@/lib/share-legal';
import { pageMetadata } from '@/lib/seo';

/** Per request: URLs come from SITE_URL (seo.ts). Never indexed: it's a personal form. */
export function generateMetadata(): Metadata {
  return {
    ...pageMetadata({
      title: 'Share your story',
      description:
        'Share your testimony: it could be exactly what someone needs to hear today.',
      path: '/share',
    }),
    robots: { index: false, follow: true },
  };
}

/**
 * Share your story (M2 plan PR 4: written stories; mockup authenticated/submit.html). The
 * server renders the frame and reads the testimony form, the social sharing form and the
 * privacy document in force from api-public-read (D32); the flow itself runs in the browser
 * against api-user with the person's Clerk token (D83), so it needs JavaScript.
 */
export default async function SharePage() {
  await connection();
  const legal = await getShareLegal();
  const publishableKey = clerkPublishableKey();
  const apiUser = apiUserUrl();
  return (
    <main id="main" className="flex-1 py-12 sm:py-16">
      <NarrowColumn>
        <PageHeader
          eyebrow="Share"
          title="Share your story"
          lead="Your testimony could be exactly what someone needs to hear today."
        />
        <noscript>
          <p className="mb-6 rounded-2xl border border-border bg-card p-6 text-center">
            Sharing needs JavaScript. Please turn it on, or use a browser that
            has it, to share your story.
          </p>
        </noscript>
        <div data-share-slot="" className="min-h-[24rem]">
          {e2eFixtures() && apiUser ? (
            <ShareWithFixture
              signedIn={!!e2eSignedInName()}
              apiUserUrl={apiUser}
              legal={legal}
            />
          ) : publishableKey && apiUser ? (
            <ShareWithClerk apiUserUrl={apiUser} legal={legal} />
          ) : (
            <p className="text-center text-secondary-text">
              Sharing isn’t available on this site yet.
            </p>
          )}
        </div>
      </NarrowColumn>
    </main>
  );
}
