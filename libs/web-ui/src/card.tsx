import * as React from 'react';
import { Slot } from 'radix-ui';
import { cn } from './cn';

/** The panel's look: a rounded border on the card colour. */
const cardVariants = () => 'rounded-2xl border border-border bg-card';

/**
 * A panel on the card colour with a rounded border (the mockups' `.card`). Not clickable. Pass
 * spacing and layout only (padding, margins, width); `asChild` puts the look on the child
 * element instead (a `section`, `form` or `ul`).
 */
function Card({
  className,
  asChild = false,
  ...props
}: React.ComponentProps<'div'> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'div';
  return (
    <Comp
      data-slot="card"
      className={cn(cardVariants(), className)}
      {...props}
    />
  );
}

export { Card, cardVariants };
