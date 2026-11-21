import * as React from 'react';
import { cn } from './cn';

export type NoticeKind = 'danger' | 'warning' | 'success' | 'info';

/** The bar's colour, the tint and the icon's colour: theme meaning names only. */
const KIND: Record<NoticeKind, { box: string; ink: string }> = {
  danger: { box: 'border-danger bg-danger/10', ink: 'stroke-danger-text' },
  warning: { box: 'border-warning bg-warning/10', ink: 'stroke-warning' },
  success: { box: 'border-success bg-success/10', ink: 'stroke-success-text' },
  info: { box: 'border-info bg-info/10', ink: 'stroke-info' },
};

/** A1's plain icons, drawn in the kind's colour. */
function Icon({ kind }: { kind: NoticeKind }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      data-notice-icon={kind}
      className={cn(
        'mt-[0.2em] size-[1.125em] shrink-0 fill-none stroke-2 [stroke-linecap:round] [stroke-linejoin:round]',
        KIND[kind].ink,
      )}
    >
      {kind === 'warning' ? (
        <>
          <path d="M12 3l10 18H2z" />
          <path d="M12 10v4.5M12 17.5v.3" strokeWidth="2.2" />
        </>
      ) : (
        <>
          <circle cx="12" cy="12" r="10" />
          {kind === 'info' && <path d="M12 11v6M12 7.5v.5" strokeWidth="2.2" />}
          {kind === 'success' && (
            <path d="M7.5 12.5l3 3 6-6.5" strokeWidth="2.2" />
          )}
          {kind === 'danger' && (
            <path d="M8.5 8.5l7 7M15.5 8.5l-7 7" strokeWidth="2.2" />
          )}
        </>
      )}
    </svg>
  );
}

/**
 * The site's notice (NT-1 A1, Joel, 21 November 2026: option A exactly as drawn in round 1):
 * something that just happened or needs attention, in one of four kinds by meaning: `danger`
 * (it went wrong), `warning` (needs a second look), `success` (done), `info` (worth knowing).
 * A tinted box, the whole box rounded, a 4 px bar on the left in the kind's colour, the kind's
 * plain icon, and an optional bold `title` on its own line. Words stay the page's text colour.
 * Its padding and gap are A1's pixels, so large text grows the words (and the icon with them),
 * not the space round them: a button inside keeps room for whole words on a 320 px phone.
 *
 * It adds no live-region role: the page passes `role="alert"` or `role="status"` where it
 * announces today, and for a region that must be in the page before its words arrive, keeps
 * the role on its own wrapper with the Notice inside. Quiet context (the weekly limit, empty
 * lists) is `Quiet`, not a notice (NT-2 B).
 */
function Notice({
  kind,
  title,
  children,
  className,
  as: Comp = 'div',
  ref,
  ...props
}: {
  kind: NoticeKind;
  /** A bold first line ("What our team said"). */
  title?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  /** `p` for a one-line notice inside text; `div` (the default) when it holds blocks. */
  as?: 'div' | 'p' | 'section';
  /** The element, to move focus to it (`tabIndex={-1}`). */
  ref?: React.Ref<HTMLElement>;
} & Omit<React.HTMLAttributes<HTMLElement>, 'title'> &
  Record<`data-${string}`, string | undefined>) {
  const Inner = Comp === 'p' ? 'span' : 'div';
  return (
    <Comp
      data-slot="notice"
      data-kind={kind}
      className={cn(
        'flex items-start gap-[10px] rounded-xl border-l-4 px-[14px] py-[11px] text-foreground [overflow-wrap:anywhere]',
        KIND[kind].box,
        className,
      )}
      ref={ref as React.Ref<HTMLDivElement>}
      {...props}
    >
      <Icon kind={kind} />
      <Inner className={cn('min-w-0 flex-1', Comp === 'p' && 'block')}>
        {title && <span className="block font-bold">{title}</span>}
        {children}
      </Inner>
    </Comp>
  );
}

export { Notice };
