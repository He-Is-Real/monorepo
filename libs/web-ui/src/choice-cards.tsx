'use client';

import * as React from 'react';
import { cn } from './cn';

export type ChoiceOption<T extends string> = {
  value: T;
  label: React.ReactNode;
  /** A small line under the label (cards only). */
  note?: React.ReactNode;
};

/**
 * Big choice cards (CB-2 B, Joel, 20 November 2026: Share's Written / Video / Audio, as they
 * were): native radios in a fieldset, each a card at least 80 px tall; the chosen one a 2 px
 * brand edge, the pale brand fill and bold words. Arrow keys move between them. Three across
 * from 640 px, stacked on phones.
 */
function ChoiceCards<T extends string>({
  legend,
  name,
  options,
  value,
  onValueChange,
  className,
}: {
  /** Read out for the group (visually hidden). */
  legend: string;
  name: string;
  options: readonly ChoiceOption<T>[];
  value: T;
  onValueChange: (value: T) => void;
  className?: string;
}) {
  return (
    <fieldset data-slot="choice-cards" className={className}>
      <legend className="sr-only">{legend}</legend>
      <div className="grid gap-3 sm:grid-cols-3">
        {options.map((o) => (
          <label
            key={o.value}
            className={cn(
              'flex min-h-20 cursor-pointer flex-col items-center justify-center gap-1 rounded-xl p-4 text-center has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50',
              value === o.value
                ? 'border-2 border-brand bg-accent font-semibold'
                : 'border border-border text-secondary-text',
            )}
          >
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={value === o.value}
              onChange={() => onValueChange(o.value)}
              className="sr-only"
            />
            <span>{o.label}</span>
            {o.note !== undefined && (
              <span className="text-xs font-normal text-secondary-text">
                {o.note}
              </span>
            )}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * A segmented switcher (CB-2 B: the donate page's One-off / Monthly, as it was): native radios
 * in a rounded tray, the chosen one filled with the primary colour. Arrow keys move between
 * them, Tab leaves the group. Named by `aria-labelledby` (a visible question above it).
 */
function SegmentedChoice<T extends string>({
  name,
  options,
  value,
  onValueChange,
  className,
  ...props
}: {
  name: string;
  options: readonly ChoiceOption<T>[];
  value: T;
  onValueChange: (value: T) => void;
  className?: string;
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'role' | 'onChange'>) {
  return (
    <div
      role="radiogroup"
      data-slot="segmented-choice"
      className={cn(
        'inline-flex max-w-full rounded-full border border-border bg-raised p-1',
        className,
      )}
      {...props}
    >
      {options.map((o) => (
        <label
          key={o.value}
          className="inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-full px-6 text-sm font-semibold text-secondary-text transition-colors has-checked:bg-primary has-checked:text-primary-foreground has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring"
        >
          <input
            type="radio"
            name={name}
            value={o.value}
            checked={value === o.value}
            onChange={() => onValueChange(o.value)}
            className="sr-only"
          />
          {o.label}
        </label>
      ))}
    </div>
  );
}

export { ChoiceCards, SegmentedChoice };
