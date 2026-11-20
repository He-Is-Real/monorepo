'use client';

import * as React from 'react';
import { cn } from './cn';
import { fieldVariants, type FieldSize } from './field-style';
import { useFieldControl } from './field';

export type InputProps = Omit<React.ComponentProps<'input'>, 'size'> & {
  /**
   * `compact` (default): small text, a search box beside drop-downs. `standard`: normal text,
   * everywhere people type (TF-1 B).
   */
  size?: FieldSize;
};

/**
 * The site's text box. Inside a `Field` it takes the field's id, hint and error wiring
 * (`aria-describedby`, `aria-invalid`). Pass layout classes only (width, flex).
 */
export function Input({ className, size = 'compact', ...props }: InputProps) {
  const control = useFieldControl(props);
  return (
    <input
      data-slot="input"
      {...props}
      {...control}
      className={cn(fieldVariants({ size }), className)}
    />
  );
}
