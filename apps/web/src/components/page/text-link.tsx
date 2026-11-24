import Link from 'next/link';
import { TextLink as LibraryTextLink } from '@heisreal/web-ui';

/**
 * A link that looks like a link: the library's `TextLink` (TX-6 A, Joel, 21 November 2026):
 * `inline` in a sentence (underlined), `standalone` on its own (semibold, underlined on hover,
 * 44 px; `touch` gives an underlined one 44 px too). Internal paths use Next's Link; external and mailto links are plain anchors that send
 * no referrer.
 */
export function TextLink({
  href,
  kind = 'inline',
  touch = false,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<typeof Link>, 'href'> & {
  href: string;
  kind?: 'inline' | 'standalone';
  /** An underlined link that is its own short line's tap target: 44 px to press. */
  touch?: boolean;
}) {
  return (
    <LibraryTextLink asChild kind={kind} touch={touch} className={className}>
      {href.startsWith('/') || href.startsWith('#') ? (
        <Link href={href} {...props}>
          {children}
        </Link>
      ) : (
        <a href={href} rel="noreferrer" {...props}>
          {children}
        </a>
      )}
    </LibraryTextLink>
  );
}
