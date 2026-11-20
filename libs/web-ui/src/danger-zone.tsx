'use client';

import * as React from 'react';
import { Button } from './button';
import { cn } from './cn';
import { Confirm } from './confirm';

/**
 * The look of every delete that can't be undone (DL-1 A as changed and DL-2 A, Joel, 20
 * November 2026): a red-outlined, faintly red box with a warning sign in its title, and a solid
 * danger button with a bin, labelled just "Delete" (no grey explanation line). Pressing it
 * swaps the button for the "Are you sure?" step (`Confirm`, danger: "Keep it" is the way out;
 * focus comes back to the button after it). Used for an Admin's Delete on the moderation review
 * page, "Delete my account" on Your data, and Delete on My submissions.
 */
function DangerZone({
  title = 'Danger zone',
  actionLabel = 'Delete',
  actionProps,
  confirmProps,
  question,
  detail,
  confirmLabel,
  onConfirm,
  busy = false,
  disabled = false,
  open: openProp,
  onOpenChange,
  children,
  className,
  ...props
}: {
  /** The box's title ("Danger zone", "Danger zone (Admins)"). */
  title?: React.ReactNode;
  actionLabel?: React.ReactNode;
  /** More props for the Delete button (`aria-describedby`, `aria-label`, data attributes). */
  actionProps?: Omit<React.ComponentProps<'button'>, 'ref'> &
    Record<`data-${string}`, string | undefined>;
  /** More props for the step (data attributes). */
  confirmProps?: Record<`data-${string}`, string | undefined>;
  /** The step's question, detail, action words and action (`Confirm`'s), unless `children`. */
  question?: React.ReactNode;
  detail?: React.ReactNode;
  confirmLabel?: React.ReactNode;
  onConfirm?: () => void;
  busy?: boolean;
  /** The Delete button waits (a stale page, another action running). */
  disabled?: boolean;
  /** Controlled: whether the step is showing (the page shows its own form there instead). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * Shown in place of the step while open, instead of `Confirm` (a page whose step needs more,
   * like typing a word first). Most pages leave it out.
   */
  children?: React.ReactNode;
  className?: string;
} & Omit<React.HTMLAttributes<HTMLElement>, 'title' | 'children'>) {
  const id = React.useId();
  const [openState, setOpenState] = React.useState(false);
  const open = openProp ?? openState;
  const setOpen = (next: boolean) => {
    if (openProp === undefined) setOpenState(next);
    onOpenChange?.(next);
  };
  const button = React.useRef<HTMLButtonElement>(null);
  // When the step closes (the way out, Escape, or an action that failed), focus goes back to the
  // Delete button shown again in its place.
  const wasOpen = React.useRef(open);
  React.useEffect(() => {
    if (wasOpen.current && !open) button.current?.focus();
    wasOpen.current = open;
  }, [open]);
  return (
    <section
      aria-labelledby={`${id}-title`}
      data-slot="danger-zone"
      className={cn(
        'rounded-2xl border border-danger bg-danger/5 p-4 sm:p-5',
        className,
      )}
      {...props}
    >
      <h3
        id={`${id}-title`}
        className="mb-3 flex items-center gap-2 font-semibold text-danger-text"
      >
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          className="size-5 shrink-0 fill-none stroke-current"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
          <path d="M12 9v4M12 17h.01" />
        </svg>
        {title}
      </h3>
      {open ? (
        (children ?? (
          <Confirm
            {...confirmProps}
            danger
            question={question}
            confirmLabel={confirmLabel}
            busy={busy}
            onConfirm={() => onConfirm?.()}
            onCancel={() => setOpen(false)}
          >
            {detail}
          </Confirm>
        ))
      ) : (
        <Button
          ref={button}
          type="button"
          variant="danger"
          wrap
          disabled={disabled || busy}
          {...actionProps}
          onClick={(e) => {
            actionProps?.onClick?.(e);
            if (!e.defaultPrevented) setOpen(true);
          }}
        >
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            className="fill-none stroke-current"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6" />
          </svg>
          {actionLabel}
        </Button>
      )}
    </section>
  );
}

export { DangerZone };
