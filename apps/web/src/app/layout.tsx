import type { Metadata, Viewport } from 'next';
import { DM_Sans } from 'next/font/google';
import { Suspense } from 'react';
import { SiteHeader } from '@/components/site-header';
import { robotsNoindex } from '@/lib/config';
import { THEME_SCRIPT } from '@/lib/theme';
import './global.css';

// Self-hosted at build time by next/font: browsers never contact Google.
const dmSans = DM_Sans({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-dm-sans',
});

/** Per request, so the dev deployment's noindex comes from its environment (Terraform). */
export function generateMetadata(): Metadata {
  return {
    title: {
      default: 'He Is Real Today',
      template: '%s | He Is Real Today',
    },
    description: 'Real stories of encounters with God.',
    ...(robotsNoindex() ? { robots: { index: false, follow: false } } : {}),
  };
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover', // notched phones; the safe areas are padded in global.css
  colorScheme: 'light dark',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#111113' },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // The theme script sets `dark` before first paint, so React's markup differs from the
    // live class list by design.
    <html lang="en-GB" className={dmSans.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="flex min-h-dvh flex-col">
        <a
          href="#main"
          className="sr-only rounded-b-lg bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground hover:text-primary-foreground focus:not-sr-only focus:absolute focus:top-0 focus:left-4 focus:z-50"
        >
          Skip to content
        </a>
        <Suspense fallback={null}>
          <SiteHeader />
        </Suspense>
        {children}
      </body>
    </html>
  );
}
