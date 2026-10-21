import type { Metadata, Viewport } from 'next';
import { DM_Sans } from 'next/font/google';
import { Suspense } from 'react';
import { SiteHeader } from '@/components/site-header';
import './global.css';

// Self-hosted at build time by next/font: browsers never contact Google.
const dmSans = DM_Sans({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-dm-sans',
});

export const metadata: Metadata = {
  title: {
    default: 'He Is Real Today',
    template: '%s | He Is Real Today',
  },
  description: 'Real stories of encounters with God.',
};

export const viewport: Viewport = {
  themeColor: '#111113',
  colorScheme: 'dark',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en-GB" className={`dark ${dmSans.variable}`}>
      <body>
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
