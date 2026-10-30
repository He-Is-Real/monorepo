'use client';

import Link from 'next/link';
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
 * even from this page (Codex, #122). Next keeps useSearchParams in step with replaceState.
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
        <div className="mt-10">
          <p id="frequency-label" className="mb-3 font-semibold">
            How often would you like to give?
          </p>
          <div
            role="radiogroup"
            aria-labelledby="frequency-label"
            className="inline-flex max-w-full rounded-full border border-border bg-raised p-1"
          >
            {options.map((o) => (
              <label
                key={o.value}
                className="inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-full px-6 text-sm font-semibold text-secondary-text transition-colors has-checked:bg-primary has-checked:text-primary-foreground has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring"
              >
                <input
                  type="radio"
                  name="frequency"
                  value={o.value}
                  checked={frequency === o.value}
                  onChange={() => choose(o.value)}
                  className="sr-only"
                />
                {o.label}
              </label>
            ))}
          </div>
        </div>
      )}

      {frequency === 'one-off' && stripe.oneOffButtonId && (
        <section aria-labelledby="give-once" className="mt-8">
          <h2 id="give-once" className="text-2xl font-normal sm:text-[1.75rem]">
            Give once
          </h2>
          <p className="mt-2 mb-5 text-secondary-text">
            Choose any amount from £1.
          </p>
          <StripeBuyButton
            buttonId={stripe.oneOffButtonId}
            publishableKey={stripe.publishableKey}
          />
        </section>
      )}

      {frequency === 'monthly' && stripe.monthlyButtonId && (
        <section aria-labelledby="give-monthly" className="mt-8">
          <h2
            id="give-monthly"
            className="text-2xl font-normal sm:text-[1.75rem]"
          >
            Give monthly
          </h2>
          <p className="mt-2 text-secondary-text">
            Choose how many £1s a month: 10 is £10 a month. On Stripe’s page,
            the quantity is the number of pounds you give each month.
          </p>
          <p className="mt-2 mb-5 text-secondary-text">
            You can change or stop it at any time:{' '}
            {stripe.donorPortalUrl ? (
              <>
                <a
                  href={stripe.donorPortalUrl}
                  rel="noreferrer"
                  className="inline-flex min-h-11 items-center"
                >
                  manage your monthly gift
                </a>{' '}
                (Stripe emails you a sign-in link).
              </>
            ) : (
              <>
                <Link
                  href="/contact"
                  className="inline-flex min-h-11 items-center"
                >
                  contact us
                </Link>
                .
              </>
            )}
          </p>
          <StripeBuyButton
            buttonId={stripe.monthlyButtonId}
            publishableKey={stripe.publishableKey}
          />
        </section>
      )}
    </>
  );
}
