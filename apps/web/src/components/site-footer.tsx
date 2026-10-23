import Link from 'next/link';
import { Logo } from '@/components/logo';
import { consentChecksRelaxed } from '@/lib/site-status';

const EXPLORE = [
  { href: '/stories', label: 'Browse stories' },
  { href: '/about', label: 'About us' },
  { href: '/greatest-story', label: 'The Greatest Story' },
  { href: '/faqs', label: 'FAQs' },
];
const SHARE = [
  { href: '/get-ready', label: 'Get ready to share' },
  { href: '/next-steps', label: 'Next steps' },
  { href: '/contact', label: 'Contact us' },
];

const linkClass =
  'inline-flex min-h-11 items-center text-sm text-secondary-text hover:text-foreground';

function LinkGroup({
  heading,
  links,
}: {
  heading: string;
  links: { href: string; label: string }[];
}) {
  return (
    <div>
      <h2 className="mb-1 text-xs font-semibold text-foreground">{heading}</h2>
      <ul>
        {links.map((l) => (
          <li key={l.href}>
            <Link href={l.href} className={linkClass}>
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The site footer (home.html's): who we are, the site's pages, the legal pages and the
 * cookie notice. The site stores only what's strictly necessary (the theme the visitor picks;
 * Clerk's sign-in cookies), so PECR asks for information, not consent: a line here and the
 * details on /privacy#cookies, no banner. D48: in dev, while consent checks are relaxed for
 * dummy data, it says so.
 */
export async function SiteFooter() {
  const relaxed = await consentChecksRelaxed();
  return (
    <footer className="mt-auto border-t border-border">
      <div className="mx-auto max-w-site px-4 pt-12 pb-8 sm:px-10 sm:pt-16">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr] lg:gap-12">
          <div className="max-w-sm">
            <Logo size={36} />
            <p className="mt-4 text-sm leading-relaxed text-secondary-text">
              A collection of God Stories from everyday people around the world.
              Not affiliated with any particular Christian denomination.
            </p>
            <p className="mt-3 text-sm text-muted-foreground">
              UK-based not-for-profit. Charity registration pending.
            </p>
          </div>
          <nav
            aria-label="Footer"
            className="grid grid-cols-2 gap-6 sm:col-span-1 lg:col-span-2 lg:grid-cols-2 lg:gap-12"
          >
            <LinkGroup heading="Explore" links={EXPLORE} />
            <LinkGroup heading="Share" links={SHARE} />
          </nav>
        </div>

        <div className="mt-10 flex flex-col gap-4 border-t border-border pt-6 text-sm text-muted-foreground lg:flex-row lg:items-center lg:justify-between">
          <p>&copy; 2026 He Is Real Today.</p>
          <p>
            We only use essential cookies and storage.{' '}
            <Link
              href="/privacy#cookies"
              className="inline-flex min-h-11 items-center underline-offset-4 hover:underline"
            >
              How we use cookies
            </Link>
          </p>
          <ul className="flex gap-6">
            <li>
              <Link href="/privacy" className={linkClass}>
                Privacy policy
              </Link>
            </li>
            <li>
              <Link href="/terms" className={linkClass}>
                Terms
              </Link>
            </li>
          </ul>
        </div>

        {relaxed && (
          <p className="mt-4 text-center text-xs text-secondary-text">
            Consent checks relaxed (dev)
          </p>
        )}
      </div>
    </footer>
  );
}
