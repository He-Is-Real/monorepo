import type { Metadata, Viewport } from 'next';
import { DM_Sans } from 'next/font/google';
import { connection } from 'next/server';
import { browserThemeColour, buttonVariants } from '@heisreal/web-ui';
import { ClerkBrowser } from '@/components/auth/clerk-browser';
import { ErrorReports } from '@/components/errors/error-reports';
import { DeviceHeartsPrompt } from '@/components/favourites/device-hearts-prompt';
import { JsonLd } from '@/components/page/json-ld';
import { RestartingNotice } from '@/components/restarting/restarting-message';
import { SiteFooter } from '@/components/site-footer';
import { SiteHeader } from '@/components/site-header';
import {
  apiUserUrl,
  clerkPublishableKey,
  e2eFixtures,
  robotsNoindex,
  siteUrl,
} from '@/lib/config';
import {
  SITE_DESCRIPTION,
  SITE_NAME,
  siteJsonLd,
  socialDefaults,
} from '@/lib/seo';
import { THEME_SCRIPT } from '@/lib/theme';
import './global.css';

// Self-hosted at build time by next/font: browsers never contact Google.
const dmSans = DM_Sans({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-brand',
});

/**
 * Per request, so the dev deployment's noindex and site URL come from its environment
 * (OpenTofu). No canonical here: pages set their own (`pageMetadata`), or they'd inherit this.
 */
export function generateMetadata(): Metadata {
  const origin = siteUrl();
  return {
    ...(origin ? { metadataBase: new URL(origin) } : {}),
    title: {
      default: SITE_NAME,
      template: `%s | ${SITE_NAME}`,
    },
    description: SITE_DESCRIPTION,
    ...socialDefaults(origin),
    ...(robotsNoindex() ? { robots: { index: false, follow: false } } : {}),
  };
}

/**
 * Cache Components (page caching, Joel 2026-11-21): the layout waits for `connection()`, so no
 * page has a static shell made at build time; this says that's intended (no "instant" checks).
 */
export const instant = false;

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover', // notched phones; the safe areas are padded in the library's theme.css
  colorScheme: 'light dark',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: browserThemeColour.light },
    { media: '(prefers-color-scheme: dark)', color: browserThemeColour.dark },
  ],
};

/**
 * Every page, in the site's one ClerkProvider (D115; clerk-browser.tsx). Per request, for the
 * deployment's publishable key (OpenTofu sets it on the Cloud Run service; images are built
 * once for every environment). So every page renders per request and nothing is rendered at
 * build time with the build's settings; a page's own saved copy (page-cache.ts) is made at
 * request time too, and holds only the page, never this layout or the header's account area. Without a key, or with the e2e fixtures (no network, T4),
 * there's no provider and no page renders anything of Clerk's.
 */
export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await connection();
  const origin = siteUrl();
  const clerkKey = e2eFixtures() ? undefined : clerkPublishableKey();
  const page = (
    <>
      <a
        href="#main"
        className={buttonVariants({
          className:
            'sr-only rounded-t-none focus:not-sr-only focus:absolute focus:top-0 focus:left-4 focus:z-50',
        })}
      >
        Skip to content
      </a>
      <SiteHeader />
      {children}
      {origin && <JsonLd data={siteJsonLd(origin)} />}
      <SiteFooter />
      {/* Signed in: offers to add this device's hearts to the account (M2). */}
      <DeviceHeartsPrompt />
      {/* An action answered "restarting" (SurrealDB on Spot): when to try again. */}
      <RestartingNotice />
      {/* Browser crashes and unanswered calls, reported to api-user (LG-1c, LG-9a). */}
      <ErrorReports apiUserUrl={apiUserUrl()} />
    </>
  );
  return (
    // The theme script sets `dark` before first paint, so React's markup differs from the
    // live class list by design.
    <html lang="en-GB" className={dmSans.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="flex min-h-dvh flex-col">
        {clerkKey ? (
          <ClerkBrowser publishableKey={clerkKey}>{page}</ClerkBrowser>
        ) : (
          page
        )}
      </body>
    </html>
  );
}
