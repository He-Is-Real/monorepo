import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

/**
 * A native <select> in the site's theme (Joel, 2026-10-24). Native, so forms work without
 * JavaScript and browsers keep their keyboard handling. Closed, it's a theme field with the
 * theme's chevron in every browser; open, Chromium shows the themed list (`.native-select` in
 * global.css: customizable select) and other browsers their own list.
 */
export function NativeSelect({
  className,
  wrapperClassName,
  ...props
}: ComponentProps<'select'> & { wrapperClassName?: string }) {
  return (
    <span className={cn('relative inline-flex', wrapperClassName)}>
      <select
        className={cn(
          'native-select h-11 w-full min-w-0 cursor-pointer rounded-lg border border-input bg-input-background py-0 pr-10 pl-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30',
          className,
        )}
        {...props}
      />
      <svg
        data-chevron=""
        viewBox="0 0 24 24"
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 fill-none stroke-muted-foreground"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </span>
  );
}
