import type { Metadata } from 'next';
import { connection } from 'next/server';
import {
  ClerkManageAccount,
  FixtureManageAccount,
} from '@/components/account/manage-account';
import { MySubmissions } from '@/components/account/my-submissions';
import { ClerkYourData, FixtureYourData } from '@/components/account/your-data';
import { NarrowColumn, PageHeader } from '@/components/page/page-header';
import { clerkPublishableKey, e2eFixtures } from '@/lib/config';
import { pageMetadata } from '@/lib/seo';

/** Never indexed: it's personal, and the same empty shell for every visitor. */
export function generateMetadata(): Metadata {
  return {
    ...pageMetadata({
      title: 'My profile',
      description: 'Your stories, your account and your choices.',
      path: '/account',
    }),
    robots: { index: false, follow: true },
  };
}

/**
 * My profile (M2 plan PR 8; mockup authenticated/profile.html). web's server renders the same
 * shell for everyone (D32); the person's stories and choices are filled in by the browser from
 * api-user (D83), with their space kept so nothing jumps. Personal details are Clerk's own panel
 * (D81): no country, display name or notification settings (no emails in M2, D79).
 */
export default async function ProfilePage() {
  await connection();
  const manage = e2eFixtures() ? (
    <FixtureManageAccount />
  ) : clerkPublishableKey() ? (
    <ClerkManageAccount />
  ) : null;
  return (
    <main id="main" className="flex-1 py-12 sm:py-16">
      <NarrowColumn>
        <PageHeader
          title="My profile"
          lead="Your stories, your account and your choices. Only you can see this page."
        />
        <noscript>
          <p className="mb-6 rounded-2xl border border-border bg-card p-6 text-center">
            Your profile needs JavaScript. Please turn it on, or use a browser
            that has it, to see it.
          </p>
        </noscript>
        <MySubmissions />
        {manage && (
          <section aria-labelledby="your-account" className="mb-12">
            <h2 id="your-account" className="mb-5 text-2xl font-normal">
              Your account
            </h2>
            <div className="rounded-2xl border border-border bg-card p-5 sm:p-6">
              <p className="mb-4 text-secondary-text">
                Your name, email address, password and Google sign-in are kept
                by our sign-in provider, Clerk. Change them there.
              </p>
              {manage}
            </div>
          </section>
        )}
        {e2eFixtures() ? (
          <FixtureYourData />
        ) : clerkPublishableKey() ? (
          <ClerkYourData />
        ) : null}
      </NarrowColumn>
    </main>
  );
}
