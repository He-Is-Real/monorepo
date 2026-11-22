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
import { Card, Notice, Text } from '@heisreal/web-ui';

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
  { href: '/admin/block-list', label: 'Block list', min: 'Admin' },
];

/**
 * The signed-in person's role once api-user has told us, else `undefined`. It is the role as it
 * counts (S-5 A): api-user reads it with the same check as api-admin (`effectiveRole`), so a
 * Moderator or Admin without a verified @heisreal.today email comes back as a User and sees no
 * staff links or pages.
 */
export function useRole(): Role | undefined {
  const session = usePersonalSession();
  const account = useAccountState(
    session.status === 'signed-in' ? session.userId : null,
  );
  return account.status === 'ready' ? account.account.role : undefined;
}

/**
 * The site's main navigation shows staff one "Admin" link, to the admin landing page (Joel,
 * 2026-11-20): for Moderators and Admins once their role is known, never for signed-out people or
 * Users. The landing page's staff menu links the rest. `known` turns true once the links are final
 * for this page load: signed out, or api-user has answered (or failed).
 */
export const ADMIN_HOME = '/admin';
/** The paths the "Admin" link counts as current on: the landing page and every staff page. */
export const isStaffPath = (pathname: string) =>
  [ADMIN_HOME, '/moderation'].some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
export function useStaffNavLinks(): {
  links: { href: string; label: string }[];
  known: boolean;
} {
  const session = usePersonalSession();
  const account = useAccountState(
    session.status === 'signed-in' ? session.userId : null,
  );
  const role = account.status === 'ready' ? account.account.role : undefined;
  return {
    links: atLeast(role, 'Moderator')
      ? [{ href: ADMIN_HOME, label: 'Admin' }]
      : [],
    known:
      session.status === 'signed-out' ||
      account.status === 'ready' ||
      account.status === 'failed',
  };
}

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
 * Links to the staff pages the person's role may use (none until their role is known), centred
 * (OQ-4 D). The row keeps its height meanwhile, so the page doesn't jump when the links appear.
 */
export function AdminNav() {
  const here = usePathname();
  const role = useRole();
  return (
    <nav aria-label="Admin pages" className="mb-8 min-h-11">
      <ul className="flex flex-wrap justify-center gap-x-6 gap-y-1">
        {ADMIN_PAGES.filter((p) => atLeast(role, p.min)).map((p) => (
          <li key={p.href}>
            {/* eslint-disable @heisreal/web-ui/no-text-look -- the staff pages' menu keeps its own links, as the site's menus do (round 3) */}
            <Link
              href={p.href}
              aria-current={here === p.href ? 'page' : undefined}
              className="group relative inline-flex min-h-11 min-w-11 items-center text-foreground underline-offset-4 after:absolute after:inset-x-0 after:bottom-1 after:h-0.5 after:bg-brand after:opacity-0 hover:underline aria-[current=page]:after:opacity-100 aria-[current=page]:hover:no-underline"
            >
              {/* The current page is bold with the site navigation's teal line under it (Joel,
                  2026-11-21). Each link is as wide as its bold self (an unseen bold copy after it, with no
                  text for screen readers), so the centred row keeps its width whichever page is
                  current (bold), and nothing moves sideways (OQ-4 D). */}
              <span
                data-label={p.label}
                className="grid after:invisible after:col-start-1 after:row-start-1 after:font-semibold after:content-[attr(data-label)_/_'']"
              >
                <span className="col-start-1 row-start-1 group-aria-[current=page]:font-semibold">
                  {p.label}
                </span>
              </span>
            </Link>
            {/* eslint-enable @heisreal/web-ui/no-text-look */}
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
    return <Text tone="quiet">Loading…</Text>;
  }
  if (session.status !== 'signed-in') {
    return (
      <Card asChild className="p-6">
        <p data-admin-refused="">
          {min === 'Moderator'
            ? 'Sign in with a moderator account to use this page.'
            : 'Sign in with an admin account to use this page.'}
        </p>
      </Card>
    );
  }
  if (!client) {
    return (
      <Card asChild className="p-6">
        <p>The admin service isn’t available on this site.</p>
      </Card>
    );
  }
  if (account.status === 'failed') {
    // The account couldn't be read: that's on our side, not a refusal.
    return (
      <Notice kind="danger" as="p" role="alert">
        {TRY_AGAIN_LATER}
      </Notice>
    );
  }
  if (!atLeast(role, min)) {
    return (
      <Card asChild className="p-6">
        <p data-admin-refused="">
          {min === 'Moderator'
            ? 'This page is for moderators.'
            : 'This page is for admins.'}
        </p>
      </Card>
    );
  }
  return <>{children(client)}</>;
}
