import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import { cn } from './cn';

/**
 * The chip look (CH-1 A, Joel, 20 November 2026): the browse chip, 44 px tall and round-ended.
 * Chosen: the brand outline, the pale brand fill, bold words and a ✓ (`Chip` draws the ✓).
 * `add` is the dashed "+ Add" chip. For a chip made of more than one control (an Admin theme's
 * name and its ×), put the look on a wrapper and the controls inside it.
 */
const variants = cva(
  'inline-flex min-h-11 min-w-11 max-w-full items-center justify-center gap-1.5 rounded-full border text-sm transition-colors has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60 has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-ring',
  {
    variants: {
      chosen: {
        true: 'border-brand bg-accent font-semibold text-foreground hover:text-foreground',
        false:
          'border-border bg-surface text-secondary-text hover:border-brand hover:text-foreground',
      },
      add: {
        true: 'border-dashed bg-transparent text-link hover:text-link-hover',
        false: '',
      },
      /** `none`: the chip's controls bring their own padding (an Admin theme's name and ×). */
      padding: { default: 'px-4', none: '' },
    },
    defaultVariants: { chosen: false, add: false, padding: 'default' },
  },
);

/** The chip's classes, merged (tailwind-merge), so `add`'s colours replace the base ones. */
function chipVariants(
  props?: Parameters<typeof variants>[0] & { className?: string },
) {
  return cn(variants(props));
}

function Tick() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      data-chip-tick=""
      className="size-4 shrink-0 fill-none stroke-brand"
      strokeWidth="2.5"
    >
      <path d="M5 12l5 5L19 7" />
    </svg>
  );
}

/**
 * A chip you press: a theme to browse by, a theme to choose when sharing, a chosen filter to
 * remove. A `button` unless `asChild` puts the look on the child (a `Link`, or a `label` round
 * a check box). `chosen` draws the ✓ before the words and the chosen look; the page still says
 * "chosen" to screen readers its own way (`aria-current`, `aria-pressed`, a checked box).
 */
function Chip({
  className,
  chosen = false,
  add = false,
  asChild = false,
  children,
  ...props
}: React.ComponentProps<'button'> &
  Omit<VariantProps<typeof variants>, 'padding'> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : 'button';
  return (
    <Comp
      data-slot="chip"
      data-chosen={chosen ? '' : undefined}
      className={cn(chipVariants({ chosen, add }), className)}
      {...(asChild ? {} : { type: 'button' as const })}
      {...props}
    >
      {asChild ? (
        children
      ) : (
        <>
          {chosen && <Tick />}
          {children}
        </>
      )}
    </Comp>
  );
}

/** The ✓ of a chosen chip, for a chip whose child (`asChild`) draws its own content: put it
 * inside the child, before the words. */
const ChipTick = Tick;

export { Chip, ChipTick, chipVariants };
