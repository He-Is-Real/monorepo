'use client';

import * as React from 'react';
import { cn } from './cn';

export interface DialogProps extends Omit<
  React.ComponentProps<'dialog'>,
  'title' | 'open' | 'onClose' | 'children'
> {
  /** Shown in the title bar; names the dialog for screen readers. */
  title: React.ReactNode;
  /** Open (shown as a modal over the page) or closed. */
  open: boolean;
  /** Called when the dialog closes: the ×, Escape, a click on the veil, or `close()` on its ref. */
  onClose: () => void;
  /** The × button's name for screen readers ("Close filters"). */
  closeLabel?: string;
  /** Buttons along the bottom, under a line (the Filters panel's "Clear all" and "Show stories"). */
  footer?: React.ReactNode;
  /** The scrolling body element, for content moved in with a portal (the Stories filters). */
  bodyRef?: React.Ref<HTMLDivElement>;
  children?: React.ReactNode;
}

/**
 * A panel over the page (MG-3 A, Joel, 21 November 2026: the Stories Filters panel's look, for
 * every dialog). On a phone it rises from the bottom, full width, within reach of a thumb; from
 * 640 px it's a centred box (40 rem wide unless the page passes a width). A title bar with the
 * title (the sub-heading look) and a × to close; the body scrolls; an optional footer of buttons.
 *
 * The browser's own modal `<dialog>`: focus stays inside, Escape closes it, and focus goes back to
 * what opened it. A click on the veil around it closes it too. `ref` reaches the `<dialog>`
 * element (`ref.current.close()`). Pages pass layout classes only (a width).
 */
export function Dialog({
  title,
  open,
  onClose,
  closeLabel = 'Close',
  footer,
  bodyRef,
  className,
  children,
  ref,
  onClick,
  ...props
}: DialogProps) {
  const own = React.useRef<HTMLDialogElement>(null);
  const titleId = React.useId();
  const setRef = (el: HTMLDialogElement | null) => {
    own.current = el;
    if (typeof ref === 'function') ref(el);
    else if (ref) ref.current = el;
  };

  React.useEffect(() => {
    const el = own.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
    return () => {
      // Taken off the page while open: close it, so focus goes back where it came from.
      if (open && el.open) el.close();
    };
  }, [open]);

  return (
    <dialog
      ref={setRef}
      aria-labelledby={titleId}
      data-slot="dialog"
      onClose={onClose}
      onClick={(e) => {
        onClick?.(e);
        // A click on the veil (the dialog itself, outside its box) closes it.
        if (e.target === e.currentTarget) e.currentTarget.close();
      }}
      className={cn(
        'mx-0 mt-auto mb-0 w-full max-w-full rounded-t-2xl border border-border-hover bg-card p-0 text-foreground backdrop:bg-overlay sm:m-auto sm:w-[min(100%-4rem,40rem)] sm:rounded-2xl',
        className,
      )}
      {...props}
    >
      <div className="flex max-h-[85svh] flex-col">
        <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-2">
          <h2
            id={titleId}
            className="min-w-0 text-lg font-semibold [overflow-wrap:anywhere]"
          >
            {title}
          </h2>
          <button
            type="button"
            onClick={() => own.current?.close()}
            className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-secondary-text hover:text-foreground"
          >
            <svg
              viewBox="0 0 24 24"
              aria-hidden="true"
              className="size-5 fill-none stroke-current"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
            <span className="sr-only">{closeLabel}</span>
          </button>
        </div>
        <div
          ref={bodyRef}
          className="min-h-0 flex-1 overflow-y-auto px-5 py-4 [overflow-wrap:anywhere]"
        >
          {children}
        </div>
        {footer !== undefined && (
          <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {footer}
          </div>
        )}
      </div>
    </dialog>
  );
}
