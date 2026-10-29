'use client';

import { SignIn } from '@clerk/react';
import { ClerkBrowser } from '@/components/auth/clerk-browser';
import {
  SIGN_UP_CONSENT_PATH,
  withReturn,
} from '@/components/consent/consent-prompts';

/**
 * Clerk's own sign-in, with sign-up in the same flow (`withSignUp`: an email without an account
 * continues to sign-up), in the browser only (D32). Google and email, as the instance allows
 * (D2); never Apple. Afterwards Clerk sends the person to `returnTo`, a path on this site
 * (return-path.ts). Hash routing keeps every step on /sign-in. Clerk's colours, font and corners
 * are the site's tokens, so it follows the light and dark themes. The page's "Welcome" is its
 * only h1, so Clerk's own h1 (each step's title) is hidden and the page labels the form.
 */
export function SignInPanel({
  publishableKey,
  returnTo,
}: {
  publishableKey: string;
  returnTo: string;
}) {
  return (
    <ClerkBrowser publishableKey={publishableKey}>
      <SignIn
        routing="hash"
        withSignUp
        forceRedirectUrl={returnTo}
        // A new account goes straight to the sign-up consent step (D73), then on to returnTo.
        signUpForceRedirectUrl={withReturn(SIGN_UP_CONSENT_PATH, returnTo)}
        appearance={APPEARANCE}
      />
    </ClerkBrowser>
  );
}

const TOUCH_TARGET = '2.75rem';

const APPEARANCE = {
  variables: {
    colorPrimary: 'var(--primary)',
    colorPrimaryForeground: 'var(--primary-foreground)',
    colorBackground: 'var(--card)',
    colorForeground: 'var(--foreground)',
    colorMutedForeground: 'var(--secondary-text)',
    colorInput: 'var(--input-background)',
    colorInputForeground: 'var(--foreground)',
    colorNeutral: 'var(--foreground)',
    colorBorder: 'var(--input)',
    colorRing: 'var(--ring)',
    colorDanger: 'var(--destructive)',
    fontFamily: 'var(--font-sans)',
    borderRadius: 'var(--radius)',
  },
  elements: {
    // As wide as the column allows, never wider than the screen (320 px phones).
    rootBox: { width: '100%' },
    cardBox: { width: '100%', maxWidth: '100%' },
    // Clerk renders each step's title as an h1; the page's "Welcome" is the only one. The
    // code step's subtitle carries its title instead (CLERK_LOCALIZATION, clerk-browser.tsx).
    headerTitle: { display: 'none' },
    // 44 px touch targets (AGENTS.md). Clerk's controls are 32 px or smaller by default.
    // `button` is every Clerk button (Google, Continue, Edit, Resend, other methods…).
    button: { minHeight: TOUCH_TARGET, minWidth: TOUCH_TARGET },
    formFieldInput: { minHeight: TOUCH_TARGET },
    // The code boxes sit under one real input, which takes their height.
    otpCodeFieldInput: { minHeight: TOUCH_TARGET },
    // The taller link would otherwise sit below its line ("Don't have any of these? Get help").
    footerAction: { alignItems: 'center' },
    footerActionLink: {
      display: 'inline-flex',
      alignItems: 'center',
      minHeight: TOUCH_TARGET,
    },
    // "Back": the label inside the link sets the link's size.
    backLink: {
      display: 'inline-flex',
      alignItems: 'center',
      minHeight: TOUCH_TARGET,
      minWidth: TOUCH_TARGET,
    },
    formFieldAction: {
      display: 'inline-flex',
      alignItems: 'center',
      minHeight: TOUCH_TARGET,
    },
  },
};

/**
 * e2e only (E2E_FIXTURES): the page without Clerk, which loads from Clerk's servers (the suite
 * runs without the network, T4; the real one is checked on dev). A box the size of Clerk's
 * card, saying where sign-in would return to.
 */
export function FixtureSignInPanel({ returnTo }: { returnTo: string }) {
  return (
    <div
      data-sign-in-fixture=""
      data-return-to={returnTo}
      className="flex min-h-[28rem] w-full items-center justify-center rounded-2xl border border-border bg-card p-8 text-center text-secondary-text"
    >
      Clerk’s sign-in (e2e stand-in)
    </div>
  );
}
