import Link from 'next/link';
import { Heading, Text } from '@heisreal/web-ui';
import { Logo } from '@/components/logo';
import { TextLink } from '@/components/page/text-link';

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

// The footer keeps its own quiet links (web-library-round3.html: the menus and footer keep theirs).
const linkClass =
  // eslint-disable-next-line @heisreal/web-ui/no-text-look -- the footer's own link look, kept by decision (round 3)
  'inline-flex min-h-11 min-w-11 items-center text-sm text-secondary-text hover:text-foreground';

function LinkGroup({
  heading,
  links,
}: {
  heading: string;
  links: { href: string; label: string }[];
}) {
  return (
    <div>
      <Heading level={2} size="small" className="mb-1">
        {heading}
      </Heading>
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
 * details on /privacy#cookies, no banner.
 */
export function SiteFooter() {
  return (
    <footer className="mt-auto border-t border-border">
      <div className="mx-auto max-w-site px-4 pt-12 pb-8 sm:px-10 sm:pt-16">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr] lg:gap-12">
          <div className="max-w-sm">
            <Logo size={36} />
            <Text size="small" tone="quiet" className="mt-4">
              A collection of God Stories from everyday people around the world.
              Not affiliated with any particular Christian denomination.
            </Text>
            <Text size="small" tone="quiet" className="mt-3">
              UK-based not-for-profit. Charity registration pending.
            </Text>
          </div>
          <nav
            aria-label="Footer"
            className="grid grid-cols-2 gap-6 sm:col-span-1 lg:col-span-2 lg:grid-cols-2 lg:gap-12"
          >
            <LinkGroup heading="Explore" links={EXPLORE} />
            <LinkGroup heading="Share" links={SHARE} />
          </nav>
        </div>

        <Text
          as="div"
          size="small"
          tone="quiet"
          className="mt-10 flex flex-col gap-4 border-t border-border pt-6 lg:flex-row lg:items-center lg:justify-between"
        >
          <p>&copy; 2026 He Is Real Today.</p>
          <p>
            We only use essential cookies and storage.{' '}
            <TextLink
              href="/privacy#cookies"
              className="inline-flex min-h-11 items-center"
            >
              How we use cookies
            </TextLink>
          </p>
          <ul className="flex gap-6">
            <li>
              <Link href="/privacy" className={linkClass}>
                Privacy notice
              </Link>
            </li>
            <li>
              <Link href="/terms" className={linkClass}>
                Terms
              </Link>
            </li>
          </ul>
        </Text>
      </div>
    </footer>
  );
}
