import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from './cn';

/**
 * A grey label that only says something (CH-2 A, Joel, 20 November 2026): a story card's themes,
 * "Coming soon" on Get ready, a story's themes in the moderators' list. Not pressable; a chip
 * (`Chip`) is. Pass layout classes only; a story card passes its own sizes.
 */
function Tag({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="tag"
      className={cn(
        'inline-flex max-w-full items-center rounded-full bg-surface px-3 py-0.5 text-xs font-medium text-secondary-text',
        className,
      )}
      {...props}
    />
  );
}

/**
 * A story's status as a dot and a word, coloured by meaning (CH-2 A): `neutral` grey (Draft,
 * Being edited), `brand` (Waiting for review, Sent back, Ready to send again, Needs a new file),
 * `success` (Published), `warning` (Taken down, Hidden), `danger` (Not accepted). Each text
 * colour is 4.5:1 or more on its tint over the card, light and dark.
 */
const statusBadgeVariants = cva(
  'inline-flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-0.5 text-sm font-semibold before:size-[7px] before:shrink-0 before:rounded-full before:bg-current',
  {
    variants: {
      tone: {
        neutral: 'bg-surface text-secondary-text',
        brand: 'bg-link/10 text-link-hover',
        success: 'bg-success/10 text-success-text',
        warning: 'bg-warning/10 text-warning',
        danger: 'bg-danger/10 text-danger-text',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

function StatusBadge({
  className,
  tone,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof statusBadgeVariants>) {
  return (
    <span
      data-slot="status-badge"
      data-tone={tone ?? 'neutral'}
      className={cn(statusBadgeVariants({ tone }), className)}
      {...props}
    />
  );
}

type StatusTone = NonNullable<VariantProps<typeof statusBadgeVariants>['tone']>;

export { StatusBadge, Tag, type StatusTone };
