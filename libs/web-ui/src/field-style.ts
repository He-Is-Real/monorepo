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
 * Text boxes and text areas. Three sizes, as the pages had them before the library (WL-1 moved
 * them here unchanged; one look is a later choice):
 * - `compact`: the drop-down's field (search boxes, filters).
 * - `form`: admin forms, at least 44 px, the surrounding text size.
 * - `writing`: where people write (sharing a story, moderators' notes): larger text and padding.
 */
export const fieldVariants = cva('', {
  variants: {
    size: {
      compact: `${COMPACT_FIELD} px-3 placeholder:text-faint aria-[invalid=true]:border-destructive`,
      form: `${FIELD_BASE} min-h-11 px-3 py-2 focus-visible:ring-ring/50 aria-[invalid=true]:border-destructive`,
      writing: `${FIELD_BASE} rounded-md px-3 py-2.5 text-base focus-visible:border-ring focus-visible:ring-ring/50`,
    },
  },
  defaultVariants: { size: 'compact' },
});

export type FieldSize = NonNullable<VariantProps<typeof fieldVariants>['size']>;
