'use client';

import { ClerkProvider } from '@clerk/react';

/**
 * The site's one Clerk setup (D115): app/layout.tsx wraps every page in it, so the header, the
 * sign-in page, the consent forms and Share all read the same session through Clerk's own
 * hooks and components.
 *
 * Clerk runs in the browser only (D32): this client component loads Clerk's browser SDK with
 * the instance's publishable key (public). Clerk keeps its session in a cookie on this origin,
 * so the browser also sends it to web's server on same-origin requests: incidental, never used.
 * web never reads, logs, stores or forwards it (enforced by apps/web/eslint.config.mjs), holds no
 * Clerk secret, and never calls api-user or api-admin; the browser does, with `getToken()`.
 *
 * `telemetry={false}`: Clerk's product telemetry (development instances: events to
 * clerk-telemetry.com and a `clerk_telemetry_throttler` entry in localStorage) is optional, so
 * not strictly necessary under PECR; the site only stores what sign-in needs (#65 review).
 *
 * `localization`: the sign-in page hides Clerk's step titles (sign-in-panel.tsx), so a subtitle
 * that only makes sense under its title says the whole thing.
 */
export function ClerkBrowser({
  publishableKey,
  children,
}: {
  publishableKey: string;
  children: React.ReactNode;
}) {
  return (
    <ClerkProvider
      publishableKey={publishableKey}
      telemetry={false}
      localization={CLERK_LOCALIZATION}
    >
      {children}
    </ClerkProvider>
  );
}

const CLERK_LOCALIZATION = {
  signIn: {
    // The first step (sign-in and sign-up combined) has a title and no subtitle by default.
    start: { subtitleCombined: 'Continue with Google or your email address' },
    // Default: title "Check your email", subtitle "to continue to {{applicationName}}".
    emailCode: {
      subtitle:
        'Check your email for a code to continue to {{applicationName}}',
    },
    // Default: title "Reset password", subtitle "to reset your password".
    forgotPassword: {
      subtitle: 'Check your email for a code to reset your password',
    },
  },
};
