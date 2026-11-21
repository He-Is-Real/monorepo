import Link from 'next/link';
import { Button } from '@heisreal/web-ui';

/**
 * A link that looks like a button: the library's `Button` on the link (BT-1 A, Joel, 20
 * November 2026), its words free to wrap. Internal paths use Next's Link; external and mailto
 * links are plain anchors that send no referrer.
 */
export function ButtonLink({
  href,
  variant = 'default',
  size = 'default',
  className,
  children,
}: {
  href: string;
  variant?: 'default' | 'outline';
  size?: 'default' | 'lg';
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Button asChild wrap variant={variant} size={size} className={className}>
      {href.startsWith('/') ? (
        <Link href={href}>{children}</Link>
      ) : (
        <a href={href} rel="noreferrer">
          {children}
        </a>
      )}
    </Button>
  );
}
