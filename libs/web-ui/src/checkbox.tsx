'use client';

import * as React from 'react';
import { cn } from './cn';

export type CheckboxProps = Omit<
  React.ComponentProps<'input'>,
  'type' | 'children' | 'size'
> & {
  /** The words: the whole line, box and words, is one target. */
  children: React.ReactNode;
  /** The box after the words, at the line's end (the Admin themes panel's "★ Highlighted"). */
  boxAfter?: boolean;
  /** The line in a pale brand box with an edge (the agreement step, Share's sharing box). */
  card?: boolean;
  /** Classes for the label (layout only). */
  className?: string;
  /** Classes for the words (their weight or size where a page needs it). */
  labelClassName?: string;
};

/**
 * The site's check box (CB-1 A, Joel, 20 November 2026): a 22 px box with the field edge (3:1
 * in light and dark), filled dark brand with a ✓ when ticked, and the whole line, box and words,
 * pressable (at least 44 px tall). A real check box underneath for keyboards and screen readers.
 * Sizes are px, not rem, so at 200% text on a 320 px phone the words keep a readable column.
 * `aria-invalid` on it outlines a `card` line in the danger colour.
 */
function Checkbox({
  children,
  boxAfter = false,
  card = false,
  className,
  labelClassName,
  disabled,
  ...props
}: CheckboxProps) {
  const box = (
    <span
      aria-hidden="true"
      data-checkbox-box=""
      className={cn(
        'flex size-[22px] shrink-0 items-center justify-center rounded-md border-2 border-input bg-input-background text-primary-foreground dark:border-faint peer-checked:border-primary peer-checked:bg-primary [&>svg]:invisible peer-checked:[&>svg]:visible',
        boxAfter ? 'order-last' : 'mt-[3px]',
      )}
    >
      <svg
        viewBox="0 0 24 24"
        className="size-[16px] fill-none stroke-current"
        strokeWidth="3"
      >
        <path d="M5 12l5 5 9-10" />
      </svg>
    </span>
  );
  return (
    <label
      data-slot="checkbox"
      className={cn(
        'flex min-h-11 gap-[12px] text-foreground has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring',
        boxAfter ? 'items-center justify-between' : 'items-start py-[10px]',
        card &&
          'rounded-xl border border-border bg-accent p-[12px] has-[[aria-invalid=true]]:border-danger sm:px-4',
        disabled ? 'opacity-70' : 'cursor-pointer',
        className,
      )}
    >
      <input
        type="checkbox"
        disabled={disabled}
        className="peer sr-only"
        {...props}
      />
      {box}
      <span data-box-label="" className={cn('min-w-0 flex-1', labelClassName)}>
        {children}
      </span>
    </label>
  );
}

export { Checkbox };
