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
 * One Buy Button, on a card that hugs it. Stripe draws a fixed 288 px iframe whatever room it is
 * given (its script sets `width: 288px !important`, and its docs offer no size attribute; Stripe's
 * own styling inside it is set in its Dashboard), so a wider card would leave the button looking
 * shrunk in the middle of an empty box: the card is the button's width plus padding, centred.
 * Stripe's iframe is light only, so the card is the light theme's in either theme (`light`,
 * global.css), and in dark mode the button sits on it rather than as a white box on the dark page.
 * On phones the card may use the column's side margin (its 1 rem gutter), with less padding,
 * as the padded card is wider than a 320 px phone's 288 px column. The element reserves the button's size (the taller button's height) so nothing
 * moves when it arrives; its text shows only until Stripe's script draws the button (Stripe's
 * shadow DOM leaves it out), or if the script is blocked.
 */
export function StripeBuyButton({
  buttonId,
  publishableKey,
}: {
  buttonId: string;
  publishableKey: string;
}) {
  return (
    <div className="-mx-4 flex justify-center sm:mx-0">
      <div className="light rounded-2xl border border-border bg-card px-3 py-6 sm:px-4">
        <stripe-buy-button
          buy-button-id={buttonId}
          publishable-key={publishableKey}
          className="flex min-h-[243px] w-72 items-center justify-center text-center text-sm text-muted-foreground"
        >
          Loading Stripe’s secure button…
        </stripe-buy-button>
      </div>
    </div>
  );
}
