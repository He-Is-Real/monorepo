import * as React from 'react';
import { cn } from './cn';

/**
 * Quiet context that isn't news (NT-2 B, Joel, 20 November 2026): a plain grey box, such as
 * "1 of 1 story left to send for review this week" on Share, or an empty list. Coloured notices
 * are for what just happened or needs attention. `as` picks the element (`div` by default; a
 * `p`, or a `section` with its own label). Pass layout classes only.
 */
function Quiet({
  as: Comp = 'div',
  className,
  ...props
}: React.HTMLAttributes<HTMLElement> & {
  as?: 'div' | 'p' | 'section';
}) {
  return (
    <Comp
      data-slot="quiet"
      className={cn(
        'rounded-xl bg-surface px-4 py-3 text-sm text-secondary-text',
        className,
      )}
      {...props}
    />
  );
}

export { Quiet };
