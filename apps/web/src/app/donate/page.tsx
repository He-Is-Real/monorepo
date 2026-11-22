import { cacheLife } from 'next/cache';
import type { Metadata } from 'next';
import { DonateChooser } from '@/components/donate/donate-chooser';
import { StripeBuyButtonScript } from '@/components/donate/stripe-buy-button';
import { NarrowColumn } from '@/components/page/page-header';
import { stripeDonations, type StripeDonations } from '@/lib/config';
import { cachedPage, type PageCacheLife } from '@/lib/page-cache';
import { pageMetadata } from '@/lib/seo';
import { Heading, Notice, Text } from '@heisreal/web-ui';
import { TextLink } from '@/components/page/text-link';

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
function DonateContent() {
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
      <Heading level={1}>Giving isn’t open yet</Heading>
      <Text size="intro" tone="quiet" className="mt-4">
        He Is Real Today is a not-for-profit. Online giving opens with a later
        version of this site. Thank you for wanting to help.
      </Text>
      <p className="mt-8">
        <TextLink href="/stories" kind="standalone">
          Read the stories
        </TextLink>
      </p>
    </>
  );
}

function Giving({ stripe }: { stripe: StripeDonations }) {
  return (
    <>
      <StripeBuyButtonScript />
      <Heading level={1}>Support this work</Heading>
      <Text size="intro" tone="quiet" className="mt-4">
        He Is Real Today is a not-for-profit. We rely on the generosity of
        people who believe these stories matter.
      </Text>
      <Text tone="quiet" className="mt-3">
        Every donation goes directly to publishing more stories and reaching
        more people searching for answers about faith.
      </Text>
      {stripe.publishableKey.startsWith('pk_test_') && (
        <Notice
          kind="warning"
          as="p"
          role="note"
          className="mt-6"
          title="Test mode — dev only."
        >
          These buttons use Stripe’s sandbox: no real money is taken. Pay with
          one of Stripe’s test cards, such as 4242 4242 4242 4242.
        </Notice>
      )}

      <DonateChooser stripe={stripe} />

      <Text
        size="small"
        tone="quiet"
        className="mt-10 border-t border-border pt-8"
      >
        Stripe, our payment provider, takes your payment on its own secure page
        and emails your receipt; we never see your card details. See our{' '}
        <TextLink href="/privacy#donations" touch>
          privacy notice
        </TextLink>
        .
      </Text>
    </>
  );
}

/** Per request, or this page's saved copy (page-cache.config.ts). */
export default function DonatePage() {
  return cachedPage('/donate', savedPage, () => <DonateContent />);
}

async function savedPage(life: PageCacheLife) {
  'use cache';
  cacheLife(life);
  return <DonateContent />;
}
