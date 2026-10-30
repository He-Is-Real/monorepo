import type { StripeDonations } from '@/lib/config';

export type Frequency = 'one-off' | 'monthly';

/**
 * The frequency `?frequency=` asks for, if its button is configured; otherwise the first one that
 * is (One-off by default). The chooser reads it from the address on every render (server and
 * browser alike).
 */
export function frequencyFor(
  stripe: StripeDonations,
  asked: string | string[] | undefined,
): Frequency {
  if (asked === 'monthly' && stripe.monthlyButtonId) return 'monthly';
  return stripe.oneOffButtonId ? 'one-off' : 'monthly';
}
