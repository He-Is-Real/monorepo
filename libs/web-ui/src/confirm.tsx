'use client';

import * as React from 'react';
import { Button } from './button';
import { cn } from './cn';

export type ConfirmProps = {
  /** The bold question ("Delete this story for good?"). */
  question: React.ReactNode;
  /** The detail under it: a line, a list, or both. */
  children?: React.ReactNode;
  /** The action button's words ("Delete story", "Yes, save"). */
  confirmLabel: React.ReactNode;
  /**
   * The way out (CD-2 B, Joel, 20 November 2026): "Keep it" when deleting, "Cancel" for saves
   * and edits. Defaults to "Keep it" for `danger`, "Cancel" otherwise.
   */
  cancelLabel?: React.ReactNode;
  onConfirm: () => void;
  /** The way out, and Escape. */
  onCancel: () => void;
  /** Something that can't be undone: a danger outline and a danger button. */
  danger?: boolean;
  /** While the action runs: both buttons wait. */
  busy?: boolean;
  /**
   * Where focus goes after the way out (or Escape), once the step has gone: usually the button
   * that opened it, which the page shows again in its place.
   */
  returnFocus?: React.RefObject<HTMLElement | null>;
  className?: string;
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'children' | 'role'>;

/**
 * The one "Are you sure?" step (CD-1 A and CD-2 B, Joel, 20 November 2026). It sits in place of
 * the buttons that opened it and works the same everywhere:
 * - a bold question, the detail (a line or a list), the action button named for what it does,
 *   and the way out, side by side (stacked full width on phones);
 * - screen readers hear it as a question (`alertdialog`, named by the question and described by
 *   the detail);
 * - keyboard focus lands on the question, never on the action button (a slip of Enter can't
 *   delete anything); Escape means no.
 * `danger` (deletes): a danger outline and a danger button.
 */
function Confirm({
  question,
  children,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  danger = false,
  busy = false,
  returnFocus,
  className,
  onKeyDown,
  ...props
}: ConfirmProps) {
  const id = React.useId();
  const questionRef = React.useRef<HTMLParagraphElement>(null);
  const cancelled = React.useRef(false);

  React.useEffect(() => {
    questionRef.current?.focus();
  }, []);
  // After the way out the page shows its buttons again; by the time this cleanup runs they are
  // in the document, so focus can go back to the one that opened the step.
  React.useEffect(
    () => () => {
      if (cancelled.current) returnFocus?.current?.focus();
    },
    [returnFocus],
  );

  const cancel = () => {
    cancelled.current = true;
    onCancel();
  };

  return (
    <div
      role="alertdialog"
      aria-labelledby={`${id}-question`}
      aria-describedby={children ? `${id}-detail` : undefined}
      data-slot="confirm"
      data-danger={danger ? '' : undefined}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        if (e.key === 'Escape' && !e.defaultPrevented && !busy) {
          e.preventDefault();
          cancel();
        }
      }}
      className={cn(
        'rounded-2xl border bg-card p-4 sm:p-5 [overflow-wrap:anywhere]',
        danger ? 'border-danger' : 'border-border-hover',
        className,
      )}
      {...props}
    >
      <p
        ref={questionRef}
        id={`${id}-question`}
        tabIndex={-1}
        className="font-bold text-foreground"
      >
        {question}
      </p>
      {children && (
        <div
          id={`${id}-detail`}
          className="mt-1 space-y-2 text-foreground [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5"
        >
          {children}
        </div>
      )}
      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
        <Button
          type="button"
          wrap
          variant={danger ? 'danger' : 'default'}
          disabled={busy}
          onClick={onConfirm}
        >
          {confirmLabel}
        </Button>
        <Button
          type="button"
          wrap
          variant="outline"
          disabled={busy}
          onClick={cancel}
        >
          {cancelLabel ?? (danger ? 'Keep it' : 'Cancel')}
        </Button>
      </div>
    </div>
  );
}

export { Confirm };
