'use client';

import * as React from 'react';
import { cn } from './cn';

export type SwitchProps = Omit<
  React.ComponentProps<'button'>,
  'onChange' | 'role' | 'children'
> & {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** The words beside it: the whole row is one 44 px target. */
  children: React.ReactNode;
};

/**
 * An on/off switch (SW-1 B, Joel, 20 November 2026), only where pressing it acts at once
 * ("Favourites only" on Stories); a choice saved later is a `Checkbox`. On: the brand track and
 * a white knob with a ✓. Off: the field edge (3:1 in light and dark) and a grey knob. A button
 * with `role="switch"` and `aria-checked`, named by its words.
 */
function Switch({
  checked,
  onCheckedChange,
  children,
  className,
  onClick,
  ...props
}: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      data-slot="switch"
      onClick={(e) => {
        onClick?.(e);
        if (!e.defaultPrevented) onCheckedChange(!checked);
      }}
      className={cn(
        'group inline-flex min-h-11 items-center gap-3 rounded-lg pr-2 font-medium text-foreground',
        className,
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-input bg-input-background transition-colors group-aria-checked:border-brand group-aria-checked:bg-brand motion-reduce:transition-none dark:border-faint"
      >
        <span className="ml-0.5 grid size-5 place-items-center rounded-full bg-secondary-text shadow transition-transform group-aria-checked:translate-x-5 group-aria-checked:bg-on-media motion-reduce:transition-none">
          <svg
            viewBox="0 0 24 24"
            data-switch-tick=""
            className="hidden size-3.5 fill-none stroke-brand-strong group-aria-checked:block"
            strokeWidth="3.5"
          >
            <path d="M5 12l5 5 9-10" />
          </svg>
        </span>
      </span>
      {children}
    </button>
  );
}

export { Switch };
