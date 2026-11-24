'use client';

import { useId, useLayoutEffect, useRef } from 'react';
import { cn } from './cn';
import { headingVariants } from './text';

export interface RadioOption {
  value: string;
  label: string;
}

export interface RadioGroupProps {
  /** The group's name, shown over it and read by screen readers (the fieldset's legend). */
  legend: string;
  /** Posted with the surrounding form (GET or POST), with or without JavaScript. */
  name?: string;
  /** The id of a form elsewhere on the page the buttons belong to (the HTML `form` attribute). */
  form?: string;
  options: readonly RadioOption[];
  /** Controlled: the caller keeps the value and updates it from `onValueChange`. */
  value?: string;
  /** Uncontrolled: the first value; the browser keeps it from then on. */
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /** Submits its form (the surrounding one, or `form`) as soon as the choice changes (filters that apply at once). */
  submitOnChange?: boolean;
  /** Layout classes for the fieldset (margins, width). */
  className?: string;
}

/**
 * The site's radio buttons (Joel, 2026-11-20: the Stories page's sort as the moderators' list's):
 * a fieldset with its legend as a small heading over a column of 44 px rows, each a drawn round
 * button (filled teal when chosen) and its words. The real inputs are there, hidden, so the
 * keyboard (arrow keys), screen readers and forms before JavaScript all work as usual.
 */
export function RadioGroup({
  legend,
  name,
  form,
  options,
  value,
  defaultValue,
  onValueChange,
  submitOnChange = false,
  className,
}: RadioGroupProps) {
  const ownName = useId();
  const group = name ?? ownName;
  const fieldset = useRef<HTMLFieldSetElement>(null);

  // Hydration: a choice made while the page's JavaScript loaded is applied now, as it would
  // have been with the JavaScript there (as `Select` does).
  useLayoutEffect(() => {
    if (!submitOnChange) return;
    const checked = fieldset.current?.querySelector<HTMLInputElement>(
      'input[type=radio]:checked',
    );
    if (checked && checked.value !== (value ?? defaultValue)) {
      onValueChange?.(checked.value);
      checked.form?.requestSubmit();
    }
    // Once, on hydration only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <fieldset ref={fieldset} className={className}>
      <legend className={cn('mb-2 block', headingVariants({ size: 'small' }))}>
        {legend}
      </legend>
      {options.map((o) => (
        <label
          key={o.value}
          className="relative flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-1 hover:bg-surface has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring"
        >
          <input
            type="radio"
            name={group}
            form={form}
            value={o.value}
            {...(value === undefined
              ? { defaultChecked: defaultValue === o.value }
              : { checked: value === o.value })}
            onChange={(e) => {
              onValueChange?.(o.value);
              if (submitOnChange) e.currentTarget.form?.requestSubmit();
            }}
            className="peer sr-only"
          />
          {/* The drawn dot beside the hidden input, in the theme's colours. */}
          <span
            aria-hidden="true"
            className={cn(
              'flex size-[22px] shrink-0 items-center justify-center rounded-full border-2 border-input bg-input-background',
              'peer-checked:border-primary peer-checked:bg-primary',
              '[&>*]:invisible peer-checked:[&>*]:visible',
            )}
          >
            <span className="size-2 rounded-full bg-primary-foreground" />
          </span>
          {o.label}
        </label>
      ))}
    </fieldset>
  );
}
