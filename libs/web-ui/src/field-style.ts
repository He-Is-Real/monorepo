import { cva, type VariantProps } from 'class-variance-authority';

/**
 * The site's text field look, shared by `Select` (closed), `Input` and `Textarea`: the theme's
 * input border and background, a teal focus ring.
 */
export const FIELD_BASE =
  'w-full rounded-lg border border-input bg-input-background text-foreground outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50';

/** The drop-down's field: 44 px tall, small text. `Select` and the compact `Input`. */
export const COMPACT_FIELD = `${FIELD_BASE} h-11 min-w-0 text-sm focus-visible:border-ring focus-visible:ring-ring/30`;

/**
 * Text boxes and text areas (TF-1 B, Joel, 20 November 2026): one look, the drop-down's corners,
 * edge and teal focus ring, in two sizes:
 * - `compact`: small text, 44 px tall, for a search box beside drop-downs (Stories, the
 *   moderators' list, the theme picker's search).
 * - `standard`: normal text, at least 44 px, everywhere people type (sharing a story, admin
 *   forms, moderators' notes, "Delete my account").
 */
export const fieldVariants = cva('', {
  variants: {
    size: {
      compact: `${COMPACT_FIELD} px-3 placeholder:text-faint aria-[invalid=true]:border-danger`,
      standard: `${FIELD_BASE} min-h-11 px-3 py-2.5 text-base placeholder:text-faint focus-visible:border-ring focus-visible:ring-ring/30 aria-[invalid=true]:border-danger`,
    },
  },
  defaultVariants: { size: 'compact' },
});

export type FieldSize = NonNullable<VariantProps<typeof fieldVariants>['size']>;
