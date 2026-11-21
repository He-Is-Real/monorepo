import * as React from 'react';
import { cn } from './cn';

/**
 * An open/close section (DS-1 A+E 4, Joel, 20 November 2026), on the browser's own
 * `<details>`/`<summary>`, so it works before the page's JavaScript loads; Tab reaches it, Enter
 * or Space opens and closes it, and screen readers say "collapsed" or "expanded".
 *
 * Closed, every one looks the same: link-coloured, underlined words with a small solid triangle
 * before them (the triangle turns down when open), at least 44 px tall. Open, `variant`:
 * - `short` (default): the content hangs from a grey bar on its left (short helpers: "See all
 *   versions", "How to format it").
 * - `long`: the words and the content sit together in a light panel with a fine edge (long
 *   reading: "Read the full version 3").
 */
function Disclosure({
  summary,
  variant = 'short',
  className,
  contentClassName,
  children,
  ...props
}: Omit<React.ComponentProps<'details'>, 'children'> & {
  /** The words to press. */
  summary: React.ReactNode;
  variant?: 'short' | 'long';
  /** Classes for the opened content (layout only). */
  contentClassName?: string;
  children: React.ReactNode;
}) {
  const long = variant === 'long';
  return (
    <details
      data-slot="disclosure"
      data-variant={variant}
      className={cn(
        'group/disclosure',
        long &&
          'rounded-xl border border-transparent open:border-border-hover open:bg-raised',
        className,
      )}
      {...props}
    >
      <summary
        className={cn(
          'inline-flex min-h-11 cursor-pointer list-none items-center gap-2 text-link hover:text-link-hover [&::-webkit-details-marker]:hidden',
          long && 'flex rounded-xl px-2.5',
        )}
      >
        <span
          aria-hidden="true"
          data-disclosure-triangle=""
          className="size-0 shrink-0 border-y-[6px] border-l-[10px] border-y-transparent border-l-current transition-transform group-open/disclosure:rotate-90 motion-reduce:transition-none"
        />
        <span className="underline decoration-1 underline-offset-[3px]">
          {summary}
        </span>
      </summary>
      <div
        data-disclosure-content=""
        className={cn(
          long
            ? 'px-3 pb-3 pl-[1.875rem]'
            : 'mt-0.5 mb-1.5 ml-[3px] border-l-4 border-input py-1 pl-3.5 dark:border-faint',
          contentClassName,
        )}
      >
        {children}
      </div>
    </details>
  );
}

export { Disclosure };
