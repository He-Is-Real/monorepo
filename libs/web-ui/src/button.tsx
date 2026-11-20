import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from './cn';
import { Slot } from 'radix-ui';

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-danger aria-invalid:ring-danger/20 dark:aria-invalid:ring-danger/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        /**
         * Can't be undone (delete, reject): moderation's checked red (OT-1, Joel, 20 November
         * 2026). White on the red 5.6:1 in light; in dark the red at 80% over the card, 5.6:1.
         */
        danger:
          'bg-danger text-danger-foreground hover:bg-danger/90 focus-visible:ring-danger/20 dark:bg-danger/80 dark:hover:bg-danger/70 dark:focus-visible:ring-danger/40',
        /**
         * Needs a second look rather than an end (moderation's Send back, OT-1): the warning
         * amber, white text 5.9:1 in light, near-black 8.6:1 in dark.
         */
        caution: 'bg-warning text-warning-foreground hover:bg-warning/90',
        outline:
          'border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50',
        secondary:
          'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost:
          'hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-4 py-2 has-[>svg]:px-3',
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: 'h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5',
        lg: 'h-10 rounded-md px-6 has-[>svg]:px-4',
        icon: 'size-9',
        'icon-xs': "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        'icon-sm': 'size-8',
        'icon-lg': 'size-10',
      },
      /**
       * Text that may wrap (admin and moderation pages): at least 44 px tall, full width on
       * phones, its own width from 640 px.
       */
      wrap: {
        true: 'h-auto min-h-11 w-full px-5 py-2 whitespace-normal sm:w-auto',
        false: '',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
      wrap: false,
    },
  },
);

function Button({
  className,
  variant = 'default',
  size = 'default',
  wrap = false,
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : 'button';

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, wrap, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
