'use client';

import { Heading, SegmentedChoice, Text } from '@heisreal/web-ui';
import { TextLink } from '@/components/page/text-link';
import { useSearchParams } from 'next/navigation';
import type { StripeDonations } from '@/lib/config';
import { type Frequency, frequencyFor } from './frequency';
import { StripeBuyButton } from './stripe-buy-button';

const OPTIONS = [
  { value: 'one-off', label: 'One-off', button: 'oneOffButtonId' },
  { value: 'monthly', label: 'Monthly', button: 'monthlyButtonId' },
] as const;

/**
 * "One-off | Monthly" (Joel, 2026-10-29): a segmented control of native radios (arrow keys move
 * between them, Tab leaves the group), showing only the chosen Stripe button. Options whose
 * button isn't configured are left out, and with one left there's no control at all. The choice
 * is kept in the address (`?frequency=monthly`; One-off has no parameter) so it can be linked,
 * and the address is the only state: a link to /donate (the header's, say) shows One-off again,
 * even from this page (Codex, #122). Next keeps useSearchParams in step with replaceState. The
 * choice, headings and text are centred on the same line as Stripe's fixed-width button below them.
 */
export function DonateChooser({ stripe }: { stripe: StripeDonations }) {
  const frequency = frequencyFor(
    stripe,
    useSearchParams().get('frequency') ?? undefined,
  );
  const options = OPTIONS.filter((o) => stripe[o.button]);

  const choose = (next: Frequency) => {
    const url = new URL(window.location.href);
    if (next === 'monthly') url.searchParams.set('frequency', 'monthly');
    else url.searchParams.delete('frequency');
    // null, as Next's docs show: Next then updates useSearchParams (its own state it ignores).
    window.history.replaceState(null, '', url);
  };

  return (
    <>
      {options.length > 1 && (
        <div className="mt-10 text-center">
          <Text id="frequency-label" weight="bold" className="mb-3">
            How often would you like to give?
          </Text>
          <SegmentedChoice
            aria-labelledby="frequency-label"
            name="frequency"
            options={options}
            value={frequency}
            onValueChange={choose}
          />
        </div>
      )}

      {frequency === 'one-off' && stripe.oneOffButtonId && (
        <section aria-labelledby="give-once" className="mt-8 text-center">
          <Heading level={2} id="give-once">
            Give once
          </Heading>
          <Text tone="quiet" className="mt-2 mb-5">
            Choose any amount from £1.
          </Text>
          <StripeBuyButton
            buttonId={stripe.oneOffButtonId}
            publishableKey={stripe.publishableKey}
          />
        </section>
      )}

      {frequency === 'monthly' && stripe.monthlyButtonId && (
        <section aria-labelledby="give-monthly" className="mt-8 text-center">
          <Heading level={2} id="give-monthly">
            Give monthly
          </Heading>
          <Text tone="quiet" className="mt-2">
            Choose how many £1s a month: 10 is £10 a month. On Stripe’s page,
            the quantity is the number of pounds you give each month.
          </Text>
          <Text tone="quiet" className="mt-2 mb-5">
            You can change or stop it at any time:{' '}
            {stripe.donorPortalUrl ? (
              <>
                <TextLink
                  href={stripe.donorPortalUrl}
                  className="inline-flex min-h-11 items-center"
                >
                  manage your monthly gift
                </TextLink>{' '}
                (Stripe emails you a sign-in link).
              </>
            ) : (
              <>
                <TextLink
                  href="/contact"
                  className="inline-flex min-h-11 items-center"
                >
                  contact us
                </TextLink>
                .
              </>
            )}
          </Text>
          <StripeBuyButton
            buttonId={stripe.monthlyButtonId}
            publishableKey={stripe.publishableKey}
          />
        </section>
      )}
    </>
  );
}
