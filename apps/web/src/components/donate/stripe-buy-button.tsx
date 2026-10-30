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
 * One Buy Button, framed on a card. Stripe draws a fixed 288 px iframe (one-off 243 px tall,
 * monthly 223 px; Stripe's own styling inside it is set in its Dashboard), light only: so the card
 * is the light theme's in either theme (`light`, global.css), and in dark mode the button sits on
 * it rather than as a white box on the dark page. Centred, and on phones the card runs edge to
 * edge, as the 288 px button fills a 320 px phone's column. The element reserves the taller
 * button's height so nothing moves when it arrives; its text shows only until Stripe's script
 * draws the button (Stripe's shadow DOM leaves it out), or if the script is blocked.
 */
export function StripeBuyButton({
  buttonId,
  publishableKey,
}: {
  buttonId: string;
  publishableKey: string;
}) {
  return (
    <div className="light -mx-4 border-y border-border bg-card px-4 py-6 sm:mx-0 sm:rounded-2xl sm:border-x">
      <stripe-buy-button
        buy-button-id={buttonId}
        publishable-key={publishableKey}
        className="flex min-h-[243px] items-center justify-center text-center text-sm text-muted-foreground"
      >
        Loading Stripe’s secure button…
      </stripe-buy-button>
    </div>
  );
}
