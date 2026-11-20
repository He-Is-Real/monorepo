'use client';

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from './cn';

interface FieldContextValue {
  id: string;
  hintId?: string;
  errorId: string;
  describedBy?: string;
  error?: React.ReactNode;
}

const FieldContext = React.createContext<FieldContextValue | null>(null);

export interface FieldProps {
  /** The control's id (the label's `htmlFor`); made up when not given. Hint: `${id}-hint`, error: `${id}-error`. */
  id?: string;
  /** True when a `FieldHint` is inside: the control is described by it. */
  hint?: boolean;
  /** The field's error: the control is marked invalid and described by `FieldError`. */
  error?: React.ReactNode;
  /** More ids that describe the control (a character count), between the hint and the error. */
  describedBy?: string;
  children: React.ReactNode;
}

/**
 * Label, hint and error wiring for one text box, text area or drop-down. It adds no element of
 * its own, so the page keeps its layout: inside it, `FieldLabel` points at the control,
 * `FieldHint` and `FieldError` describe it, and the control (`Input`, `Textarea`, `Select`)
 * takes the id, `aria-describedby` and `aria-invalid`. A control given its own `id` keeps it and
 * takes nothing from the field (a second control in the same row).
 */
export function Field({ id, hint, error, describedBy, children }: FieldProps) {
  const made = React.useId();
  const own = id ?? made;
  const value = React.useMemo(
    () => ({
      id: own,
      hintId: hint ? `${own}-hint` : undefined,
      errorId: `${own}-error`,
      describedBy,
      error,
    }),
    [own, hint, describedBy, error],
  );
  return (
    <FieldContext.Provider value={value}>{children}</FieldContext.Provider>
  );
}

const has = (error: React.ReactNode) =>
  error !== undefined && error !== null && error !== false && error !== '';

/** The props a control takes from its `Field` (none outside one, or with its own `id`). */
export function useFieldControl(props: {
  id?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: React.AriaAttributes['aria-invalid'];
}) {
  const field = React.useContext(FieldContext);
  if (!field || props.id !== undefined) return {};
  const invalid = has(field.error);
  const describedBy = [
    field.hintId,
    field.describedBy,
    props['aria-describedby'],
    invalid ? field.errorId : undefined,
  ]
    .filter(Boolean)
    .join(' ');
  return {
    id: field.id,
    'aria-describedby': describedBy || undefined,
    'aria-invalid': props['aria-invalid'] ?? (invalid ? true : undefined),
  };
}

const labelVariants = cva('block', {
  variants: {
    size: {
      /** Admin and moderation forms. */
      default: 'mb-1 font-medium text-foreground',
      /** Where people write (sharing a story, moderators' notes). */
      writing: 'mb-1.5 font-semibold',
    },
  },
  defaultVariants: { size: 'default' },
});

/** The field's label, pointing at its control. */
export function FieldLabel({
  className,
  size,
  ...props
}: Omit<React.ComponentProps<'label'>, 'htmlFor'> &
  VariantProps<typeof labelVariants>) {
  const field = React.useContext(FieldContext);
  return (
    <label
      data-slot="field-label"
      htmlFor={field?.id}
      className={cn(labelVariants({ size }), className)}
      {...props}
    />
  );
}

/** The field's hint: small, secondary text. Its `Field` needs `hint`. */
export function FieldHint({
  className,
  ...props
}: Omit<React.ComponentProps<'p'>, 'id'>) {
  const field = React.useContext(FieldContext);
  return (
    <p
      data-slot="field-hint"
      id={field?.hintId}
      className={cn('text-sm text-secondary-text', className)}
      {...props}
    />
  );
}

/** The field's error, shown only while its `Field` has one: small red text. */
export function FieldError({
  className,
  children,
  ...props
}: Omit<React.ComponentProps<'p'>, 'id'>) {
  const field = React.useContext(FieldContext);
  if (!field || !has(field.error)) return null;
  return (
    <p
      data-slot="field-error"
      id={field.errorId}
      className={cn('text-sm text-danger-text', className)}
      {...props}
    >
      {children ?? field.error}
    </p>
  );
}
