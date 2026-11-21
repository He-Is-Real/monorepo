import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from './cn';
import { Slot } from 'radix-ui';

const variants = cva(
  // BT-1 A (Joel, 20 November 2026): 44 px tall by default, semibold words, 8 px corners and the
  // site's keyboard focus (a 2 px outline with a gap, theme.css), the same on every variant.
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-semibold whitespace-nowrap transition-all disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-danger [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          'bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground',
        /**
         * Can't be undone (delete, reject): moderation's checked red (OT-1, Joel, 20 November
         * 2026). White on the red 5.6:1 in light; in dark the red at 80% over the card, 5.6:1.
         */
        danger:
          'bg-danger text-danger-foreground hover:bg-danger/90 hover:text-danger-foreground dark:bg-danger/80 dark:hover:bg-danger/70',
        /**
         * Needs a second look rather than an end (moderation's Send back, OT-1): the warning
         * amber, white text 5.9:1 in light, near-black 8.6:1 in dark.
         */
        caution:
          'bg-warning text-warning-foreground hover:bg-warning/90 hover:text-warning-foreground',
        outline:
          // One outlined look for buttons and button-links (BT-1 A): the stronger edge, teal on
          // hover, as Share's and the page links' outlined buttons were.
          'border border-border-hover bg-background text-foreground hover:border-brand hover:bg-accent hover:text-foreground dark:bg-input/30',
        secondary:
          'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost:
          'hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        /** 44 px, a fingertip. */
        default: 'h-11 px-5 has-[>svg]:px-4',
        /** 48 px: the home page's large calls to action. */
        lg: 'h-12 px-7 text-[0.9375rem] has-[>svg]:px-5',
        /** A square 44 px icon button. */
        icon: 'size-11',
      },
      /**
       * Text that may wrap (admin and moderation pages): at least 44 px tall, full width on
       * phones, its own width from 640 px.
       */
      wrap: {
        true: 'h-auto min-h-11 w-full py-2 text-center whitespace-normal sm:w-auto',
        false: '',
      },
    },
    // Wrapping buttons keep their side padding in px, so with large text (200%) on a phone the
    // words get the room instead of the padding (a 320 px phone at 200% would otherwise leave a
    // word or two per line, or one letter inside a notice).
    compoundVariants: [
      { size: 'default', wrap: true, class: 'px-[20px]' },
      { size: 'lg', wrap: true, class: 'min-h-12 px-[28px]' },
    ],
    defaultVariants: {
      variant: 'default',
      size: 'default',
      wrap: false,
    },
  },
);

/**
 * The button's classes, merged (tailwind-merge), so a variant's class replaces the base one it
 * overrides (`wrap`'s `whitespace-normal` and `h-auto` over `whitespace-nowrap` and `h-11`):
 * for plain buttons and links that can't use `Button`.
 */
function buttonVariants(
  props?: Parameters<typeof variants>[0] & { className?: string },
) {
  return cn(variants(props));
}

function Button({
  className,
  variant = 'default',
  size = 'default',
  wrap = false,
  asChild = false,
  disabledReason,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof variants> & {
    asChild?: boolean;
    /**
     * Why the button is greyed out (OT-2 A, Joel, 20 November 2026: "Write a reason first."):
     * a short line under it while it's disabled, read with it (`aria-describedby`). Only where
     * the page has a reason.
     */
    disabledReason?: React.ReactNode;
  }) {
  const Comp = asChild ? Slot.Root : 'button';
  const reasonId = React.useId();
  const why = props.disabled && disabledReason ? disabledReason : null;

  const button = (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={buttonVariants({ variant, size, wrap, className })}
      {...props}
      aria-describedby={
        why
          ? [props['aria-describedby'], reasonId].filter(Boolean).join(' ')
          : props['aria-describedby']
      }
    />
  );
  if (!why) return button;
  return (
    <span
      data-slot="button-with-reason"
      className={cn('inline-flex flex-col gap-1', wrap && 'w-full sm:w-auto')}
    >
      {button}
      <span
        id={reasonId}
        data-disabled-reason=""
        className="text-[0.8125rem] text-secondary-text"
      >
        {why}
      </span>
    </span>
  );
}

export { Button, buttonVariants };
