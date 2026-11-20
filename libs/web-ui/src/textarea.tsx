'use client';

import * as React from 'react';
import { cn } from './cn';
import { fieldVariants, type FieldSize } from './field-style';
import { useFieldControl } from './field';

export type TextareaProps = React.ComponentProps<'textarea'> & {
  /** `writing` (default): sharing a story, moderators' notes. `form`: admin forms. */
  size?: Exclude<FieldSize, 'compact'>;
};

/**
 * The site's text area: the text box's look, taller (set its height with a `min-h-*` class).
 * Inside a `Field` it takes the field's id, hint and error wiring.
 */
export function Textarea({
  className,
  size = 'writing',
  ...props
}: TextareaProps) {
  const control = useFieldControl(props);
  return (
    <textarea
      data-slot="textarea"
      {...props}
      {...control}
      className={cn(fieldVariants({ size }), className)}
    />
  );
}
