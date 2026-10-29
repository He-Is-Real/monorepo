import type { StripeDonations } from '@/lib/config';

export type Frequency = 'one-off' | 'monthly';

/**
 * The frequency `?frequency=` asks for, if its button is configured; otherwise the first one that
 * is (One-off by default). Used by the server to render the chosen button straight away.
 */
export function frequencyFor(
  stripe: StripeDonations,
  asked: string | string[] | undefined,
): Frequency {
  if (asked === 'monthly' && stripe.monthlyButtonId) return 'monthly';
  return stripe.oneOffButtonId ? 'one-off' : 'monthly';
}
