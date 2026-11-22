'use client';

import { cn } from './cn';
import { Input, type InputProps } from './input';

export type SearchBoxProps = Omit<InputProps, 'type' | 'size'> & {
  /** The magnifier button's name for screen readers and the keyboard (default "Search"). */
  buttonLabel?: string;
  /** Classes for the wrapper: its width, mostly. */
  wrapperClassName?: string;
};

/**
 * The site's search box (BS-2 A, Joel 2026-11-20): the text box with a magnifier button inside
 * it at the end. The button is a real submit button named "Search", so Enter, the keyboard,
 * screen readers and pages before JavaScript all search with it. Inside a `<form>`.
 */
export function SearchBox({
  buttonLabel = 'Search',
  wrapperClassName,
  className,
  ...input
}: SearchBoxProps) {
  return (
    <div className={cn('relative flex', wrapperClassName)}>
      <Input type="search" {...input} className={cn('pr-12', className)} />
      <button
        type="submit"
        data-slot="search-button"
        className="absolute top-0 right-0 inline-flex size-11 items-center justify-center rounded-lg text-secondary-text hover:text-link"
      >
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          className="size-5 fill-none stroke-current"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="M16.5 16.5 21 21" />
        </svg>
        <span className="sr-only">{buttonLabel}</span>
      </button>
    </div>
  );
}
