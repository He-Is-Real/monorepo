import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import { cn } from './cn';

const cardVariants = cva('rounded-2xl border bg-card', {
  variants: {
    tone: {
      default: 'border-border',
      /** An error, or something that can't be undone. */
      destructive: 'border-destructive',
      /** The thing to do next (a chosen or highlighted panel). */
      primary: 'border-primary',
      /** A note that links on (the link colour). */
      link: 'border-link',
    },
  },
  defaultVariants: { tone: 'default' },
});

/**
 * A panel on the card colour with a rounded border (the mockups' `.card`). Not clickable. Pass
 * spacing and layout only (padding, margins, width); `asChild` puts the look on the child
 * element instead (a `section`, `form` or `ul`).
 */
function Card({
  className,
  tone,
  asChild = false,
  ...props
}: React.ComponentProps<'div'> &
  VariantProps<typeof cardVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'div';
  return (
    <Comp
      data-slot="card"
      className={cn(cardVariants({ tone }), className)}
      {...props}
    />
  );
}

export { Card, cardVariants };
