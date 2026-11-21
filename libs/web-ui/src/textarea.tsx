'use client';

import * as React from 'react';
import { cn } from './cn';
import { fieldVariants } from './field-style';
import { useFieldControl } from './field';

export type TextareaProps = React.ComponentProps<'textarea'>;

/**
 * The site's text area: the standard text box (TF-1 B), taller (set its height with a `min-h-*` class).
 * Inside a `Field` it takes the field's id, hint and error wiring.
 */
export function Textarea({ className, ...props }: TextareaProps) {
  const control = useFieldControl(props);
  return (
    <textarea
      data-slot="textarea"
      {...props}
      {...control}
      className={cn(fieldVariants({ size: 'standard' }), className)}
    />
  );
}
