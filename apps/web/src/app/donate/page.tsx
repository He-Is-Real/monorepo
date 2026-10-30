import type { Metadata } from 'next';
import Link from 'next/link';
import { connection } from 'next/server';
import { DonateChooser } from '@/components/donate/donate-chooser';
import { StripeBuyButtonScript } from '@/components/donate/stripe-buy-button';
import { NarrowColumn } from '@/components/page/page-header';
import { stripeDonations, type StripeDonations } from '@/lib/config';
import { pageMetadata } from '@/lib/seo';

/** At request time: the site's address (SITE_URL) and the Stripe settings are read per request. */
export async function generateMetadata(): Promise<Metadata> {
  return pageMetadata({
    title: 'Support this work',
    description: stripeDonations()
      ? 'He Is Real Today is a not-for-profit. Give once or every month, through Stripe.'
      : 'He Is Real Today is a not-for-profit. Online giving opens soon.',
    path: '/donate',
  });
}

/**
 * Giving (M4; Joel, 2026-10-29): Stripe's Buy Buttons, one-off and monthly, behind a "One-off |
 * Monthly" choice, for whichever OpenTofu has set in this environment (`web_donations`);
 * otherwise the placeholder. Stripe's script loads on this page only.
 */
export default async function DonatePage() {
  await connection(); // the Stripe settings are read per request, never at build time
  const stripe = stripeDonations();
  return (
    <main id="main" className="flex-1 py-16 sm:py-24">
      <NarrowColumn>
        {stripe ? <Giving stripe={stripe} /> : <NotOpenYet />}
      </NarrowColumn>
    </main>
  );
}

function NotOpenYet() {
  return (
    <>
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
    </>
  );
}

function Giving({ stripe }: { stripe: StripeDonations }) {
  return (
    <>
      <StripeBuyButtonScript />
      <h1 className="text-3xl leading-tight font-normal sm:text-4xl">
        Support this work
      </h1>
      <p className="mt-4 text-lg text-secondary-text">
        He Is Real Today is a not-for-profit. We rely on the generosity of
        people who believe these stories matter.
      </p>
      <p className="mt-3 text-secondary-text">
        Every donation goes directly to publishing more stories and reaching
        more people searching for answers about faith.
      </p>
      {stripe.publishableKey.startsWith('pk_test_') && (
        <p
          role="note"
          className="mt-6 rounded-xl border border-warning/50 bg-warning/10 px-4 py-3 text-sm text-foreground"
        >
          <strong>Test mode — dev only.</strong> These buttons use Stripe’s
          sandbox: no real money is taken. Pay with one of Stripe’s test cards,
          such as 4242 4242 4242 4242.
        </p>
      )}

      <DonateChooser stripe={stripe} />

      <p className="mt-10 border-t border-border pt-8 text-sm text-secondary-text">
        Stripe, our payment provider, takes your payment on its own secure page
        and emails your receipt; we never see your card details. See our{' '}
        <Link
          href="/privacy#donations"
          className="inline-flex min-h-11 items-center"
        >
          privacy policy
        </Link>
        .
      </p>
    </>
  );
}
