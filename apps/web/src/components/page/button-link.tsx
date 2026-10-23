import Link from 'next/link';

const VARIANTS = {
  primary:
    'bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground',
  secondary:
    'border border-border-hover text-secondary-text hover:border-teal hover:bg-accent hover:text-foreground',
} as const;

/**
 * A link that looks like a button (the mockups' `.btn`), at least 44 px tall. Internal paths
 * use Next's Link; external and mailto links are plain anchors that send no referrer.
 */
export function ButtonLink({
  href,
  variant = 'primary',
  size = 'default',
  className = '',
  children,
}: {
  href: string;
  variant?: keyof typeof VARIANTS;
  size?: 'default' | 'lg';
  className?: string;
  children: React.ReactNode;
}) {
  const classes = `inline-flex min-h-11 items-center justify-center gap-2 rounded-md text-center font-semibold transition-colors ${
    size === 'lg' ? 'px-7 py-3 text-[15px]' : 'px-5 py-2.5 text-sm'
  } ${VARIANTS[variant]} ${className}`;
  if (href.startsWith('/')) {
    return (
      <Link href={href} className={classes}>
        {children}
      </Link>
    );
  }
  return (
    <a href={href} rel="noreferrer" className={classes}>
      {children}
    </a>
  );
}
