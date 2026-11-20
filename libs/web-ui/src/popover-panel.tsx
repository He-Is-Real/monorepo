'use client';

import * as React from 'react';
import { Popover } from 'radix-ui';
import { cn } from './cn';

/**
 * The panel of a pop-up menu (the share menu, the account menu): Radix Popover's content in a
 * portal, on the card colour with a shadow, below its button and lined up with its end, no wider
 * than the screen and scrolling when taller than the space. Use inside a `Popover.Root`; pass
 * padding only.
 */
export function PopoverPanel({
  className,
  side = 'bottom',
  align = 'end',
  sideOffset = 8,
  collisionPadding = 16,
  ...props
}: React.ComponentProps<typeof Popover.Content>) {
  return (
    <Popover.Portal>
      <Popover.Content
        data-slot="popover-panel"
        side={side}
        align={align}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          'z-50 max-h-[var(--radix-popover-content-available-height)] w-64 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-2xl border border-border-hover bg-card text-card-foreground shadow-2xl outline-none data-[state=open]:animate-in data-[state=open]:fade-in data-[state=open]:zoom-in-95',
          className,
        )}
        {...props}
      />
    </Popover.Portal>
  );
}
