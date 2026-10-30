import Script from 'next/script';

// Stripe's Buy Button (Joel, 2026-10-29): Stripe's own web component, as its Dashboard snippet
// gives it. Stripe's script fills it with an iframe from js.stripe.com, and the click opens
// Stripe's hosted payment page: no card data, and no donor data, touches this site.

declare module 'react' {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      'stripe-buy-button': React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement>,
        HTMLElement
      > & { 'buy-button-id': string; 'publishable-key': string };
    }
  }
}

export const STRIPE_BUY_BUTTON_SCRIPT =
  'https://js.stripe.com/v3/buy-button.js';

/** Stripe's script, once per page; render it only where a button is (it loads nothing else). */
export function StripeBuyButtonScript() {
  return <Script src={STRIPE_BUY_BUTTON_SCRIPT} strategy="afterInteractive" />;
}

/**
 * One Buy Button. The text inside shows only until Stripe's script draws the button (its own
 * shadow DOM hides it), or if the script is blocked.
 */
export function StripeBuyButton({
  buttonId,
  publishableKey,
}: {
  buttonId: string;
  publishableKey: string;
}) {
  return (
    <stripe-buy-button
      buy-button-id={buttonId}
      publishable-key={publishableKey}
      className="block min-h-11 max-w-full text-sm text-muted-foreground"
    >
      Loading Stripe’s secure button…
    </stripe-buy-button>
  );
}
