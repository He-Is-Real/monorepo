'use client';

import * as React from 'react';
import { cn } from './cn';

export type TabItem<T extends string> = {
  value: T;
  label: React.ReactNode;
  /** A small second line under the label (a version and its date). */
  detail?: React.ReactNode;
  /** Data attributes or other props for the tab's button. */
  props?: React.ButtonHTMLAttributes<HTMLButtonElement> &
    Record<`data-${string}`, string | undefined>;
};

/** A tab's id, for its panel's `aria-labelledby`: `${idBase}-tab-${value}`. */
export const tabId = (idBase: string, value: string) =>
  `${idBase}-tab-${value}`;

/**
 * Underlined tabs (TB-1 A, Joel, 20 November 2026: as built for Consent & legal on 17
 * November). One row on a shared rule, the chosen tab bold and underlined in the primary
 * colour; under 768 px two rows of two, each cell with its own rule. The ARIA tabs pattern:
 * one tab in the Tab order, arrow keys move between tabs and choose (`onValueChange`). The page
 * draws the panel (`role="tabpanel"`, id `panelId`, `aria-labelledby={tabId(idBase, value)}`).
 */
function Tabs<T extends string>({
  label,
  items,
  value,
  onValueChange,
  idBase,
  panelId,
  className,
  ...props
}: {
  /** The list's accessible name. */
  label: string;
  items: readonly TabItem<T>[];
  value: T;
  onValueChange: (value: T) => void;
  idBase: string;
  panelId: string;
  className?: string;
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'role' | 'onKeyDown'>) {
  const refs = React.useRef(new Map<T, HTMLButtonElement>());
  const onKey = (event: React.KeyboardEvent) => {
    const step =
      event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const i = items.findIndex((t) => t.value === value);
    const next = items[(i + step + items.length) % items.length];
    if (!next) return;
    onValueChange(next.value);
    refs.current.get(next.value)?.focus();
  };
  return (
    <div
      role="tablist"
      aria-label={label}
      onKeyDown={onKey}
      data-slot="tabs"
      className={cn(
        'grid grid-cols-2 md:flex md:border-b md:border-border',
        className,
      )}
      {...props}
    >
      {items.map((t) => (
        <button
          key={t.value}
          ref={(el) => {
            if (el) refs.current.set(t.value, el);
            else refs.current.delete(t.value);
          }}
          type="button"
          role="tab"
          id={tabId(idBase, t.value)}
          aria-selected={value === t.value}
          aria-controls={panelId}
          tabIndex={value === t.value ? 0 : -1}
          onClick={() => onValueChange(t.value)}
          // Under 768 px a 2×2 grid, each cell with its own underline (a 1 px rule; the chosen
          // one 3 px); from 768 px one row on a shared rule, the chosen one underlined.
          className="flex min-h-11 min-w-0 flex-col items-start justify-center px-3 py-2 text-left leading-snug text-secondary-text shadow-[inset_0_-1px_0_var(--color-border)] hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none aria-selected:font-semibold aria-selected:text-foreground aria-selected:shadow-[inset_0_-3px_0_var(--color-primary)] md:-mb-px md:px-4 md:shadow-none md:aria-selected:shadow-[inset_0_-3px_0_var(--color-primary)]"
          {...t.props}
        >
          <span>{t.label}</span>
          {t.detail !== undefined && (
            <span className="text-sm font-normal text-secondary-text">
              {t.detail}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

export { Tabs };
