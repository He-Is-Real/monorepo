'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useMemo } from 'react';
import { useAccountState } from '@/components/auth/account-bootstrap';
import {
  type Account,
  type ApiUser,
  ApiUserProblem,
  apiUser,
  isSystemError,
  NotSignedIn,
} from '@/lib/api-user';
import { usePersonalSession } from '@/lib/personal-session';
import { TRY_AGAIN_LATER } from '@/lib/try-again-later';

type Role = Account['role'];
/** D1's order: each role can do what the ones before it can (S-1: Moderator, then Admin). */
const RANK: Record<Role, number> = {
  Viewer: 0,
  User: 1,
  Moderator: 2,
  Admin: 3,
};
/** The lowest role a staff page is for. */
export type StaffRole = 'Moderator' | 'Admin';
const atLeast = (role: Role | undefined, min: StaffRole) =>
  role !== undefined && RANK[role] >= RANK[min];

/**
 * The staff pages, each linking the others, each shown to its role and up: Moderation to
 * Moderators and Admins (M3 plan PR 1), the rest to Admins only (G24).
 */
const ADMIN_PAGES: { href: string; label: string; min: StaffRole }[] = [
  { href: '/moderation', label: 'Moderation', min: 'Moderator' },
  { href: '/admin/consent', label: 'Consent & legal', min: 'Admin' },
  { href: '/admin/limits', label: 'Submission limits', min: 'Admin' },
  { href: '/admin/themes', label: 'Themes', min: 'Admin' },
  { href: '/admin/staff', label: 'Staff', min: 'Admin' },
];

/** The signed-in person's role once api-user has told us, else `undefined`. */
function useRole(): Role | undefined {
  const session = usePersonalSession();
  const account = useAccountState(
    session.status === 'signed-in' ? session.userId : null,
  );
  return account.status === 'ready' ? account.account.role : undefined;
}

/** A button whose words may wrap (200% text on a 320 px phone): full width there. */
export const WRAPPING_BUTTON =
  'h-auto min-h-11 w-full px-5 py-2 whitespace-normal sm:w-auto';

/**
 * What to tell an admin when api-admin refused what they sent (an input refusal's own message,
 * `isInputRefusal`), or only `TRY_AGAIN_LATER` for anything else (Joel, 2026-11-09).
 */
export const problemText = (err: unknown) => {
  if (err instanceof NotSignedIn) return 'You’re signed out. Sign in again.';
  if (err instanceof ApiUserProblem && !isSystemError(err)) {
    const field = err.problem.errors?.[0]?.message;
    return field ?? err.problem.detail ?? TRY_AGAIN_LATER;
  }
  return TRY_AGAIN_LATER;
};

/**
 * Links to the staff pages the person's role may use (none until their role is known). The row
 * keeps its height meanwhile, so the page doesn't jump when the links appear.
 */
export function AdminNav() {
  const here = usePathname();
  const role = useRole();
  return (
    <nav aria-label="Admin pages" className="mb-8 min-h-11">
      <ul className="flex flex-wrap gap-x-6 gap-y-1">
        {ADMIN_PAGES.filter((p) => atLeast(role, p.min)).map((p) => (
          <li key={p.href}>
            <Link
              href={p.href}
              aria-current={here === p.href ? 'page' : undefined}
              className="inline-flex min-h-11 min-w-11 items-center text-foreground underline-offset-4 hover:underline aria-[current=page]:font-semibold"
            >
              {p.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * The staff gate every admin page shares (D1): api-admin's client for a signed-in person of at
 * least `min` (Admin unless the page says Moderator), or what to tell anyone else. api-admin
 * checks the role again on every call; this only spares others a page of errors. The browser
 * calls api-admin with the person's own token (D31), through the same client as api-user.
 */
export function AdminAccess({
  apiAdminUrl,
  min = 'Admin',
  children,
}: {
  apiAdminUrl?: string;
  min?: StaffRole;
  children: (client: ApiUser) => React.ReactNode;
}) {
  const session = usePersonalSession();
  const userId = session.status === 'signed-in' ? session.userId : null;
  const account = useAccountState(userId);
  const getToken = session.status === 'signed-in' ? session.getToken : null;
  const client = useMemo(
    () => (getToken && apiAdminUrl ? apiUser(apiAdminUrl, getToken) : null),
    [getToken, apiAdminUrl],
  );
  const role = account.status === 'ready' ? account.account.role : undefined;

  if (
    session.status === 'unknown' ||
    (userId && account.status !== 'ready' && account.status !== 'failed')
  ) {
    return <p className="text-secondary-text">Loading…</p>;
  }
  if (session.status !== 'signed-in') {
    return (
      <p
        className="rounded-2xl border border-border bg-card p-6"
        data-admin-refused=""
      >
        {min === 'Moderator'
          ? 'Sign in with a moderator account to use this page.'
          : 'Sign in with an admin account to use this page.'}
      </p>
    );
  }
  if (!client) {
    return (
      <p className="rounded-2xl border border-border bg-card p-6">
        The admin service isn’t available on this site.
      </p>
    );
  }
  if (account.status === 'failed') {
    // The account couldn't be read: that's on our side, not a refusal.
    return (
      <p role="alert" className="rounded-2xl border border-border bg-card p-6">
        {TRY_AGAIN_LATER}
      </p>
    );
  }
  if (!atLeast(role, min)) {
    return (
      <p
        className="rounded-2xl border border-border bg-card p-6"
        data-admin-refused=""
      >
        {min === 'Moderator'
          ? 'This page is for moderators.'
          : 'This page is for admins.'}
      </p>
    );
  }
  return <>{children(client)}</>;
}
