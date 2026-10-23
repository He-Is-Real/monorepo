import type { Metadata } from 'next';
import Link from 'next/link';
import { pageMetadata } from '@/lib/seo';

/** At request time: the site's address (SITE_URL) is read per request. */
export async function generateMetadata(): Promise<Metadata> {
  return pageMetadata({
    title: 'Support this work',
    description:
      'He Is Real Today is a not-for-profit. Online giving opens soon.',
    path: '/donate',
  });
}

/** A placeholder for giving: donations are M4. No payment of any kind here. */
export default function DonatePage() {
  return (
    <main
      id="main"
      className="mx-auto w-full max-w-prose flex-1 px-4 py-16 sm:py-24"
    >
      <h1 className="text-3xl leading-tight font-normal sm:text-4xl">
        Giving isn’t open yet
      </h1>
      <p className="mt-4 text-lg text-secondary-text">
        He Is Real Today is a not-for-profit. Online giving opens with a later
        version of this site. Thank you for wanting to help.
      </p>
      <p className="mt-8">
        <Link
          href="/stories"
          className="inline-flex min-h-11 items-center font-medium"
        >
          Read the stories
        </Link>
      </p>
    </main>
  );
}
