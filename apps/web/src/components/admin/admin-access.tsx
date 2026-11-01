'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useMemo } from 'react';
import { useAccountState } from '@/components/auth/account-bootstrap';
import {
  type ApiUser,
  ApiUserProblem,
  apiUser,
  NotSignedIn,
} from '@/lib/api-user';
import { usePersonalSession } from '@/lib/personal-session';

const ADMIN_ROLES = new Set(['Admin', 'SuperAdmin']);

/** The admin pages, each linking the others. */
const ADMIN_PAGES = [
  { href: '/admin/consent', label: 'Consent & legal' },
  { href: '/admin/limits', label: 'Submission limits' },
  { href: '/admin/themes', label: 'Themes' },
];

/** A button whose words may wrap (200% text on a 320 px phone): full width there. */
export const WRAPPING_BUTTON =
  'h-auto min-h-11 w-full px-5 py-2 whitespace-normal sm:w-auto';

/** What to tell an admin when api-admin refused or couldn't be reached. */
export const problemText = (err: unknown) => {
  if (err instanceof ApiUserProblem) {
    const field = err.problem.errors?.[0]?.message;
    return field ?? err.problem.detail ?? `api-admin answered ${err.status}.`;
  }
  if (err instanceof NotSignedIn) return 'You’re signed out. Sign in again.';
  return 'api-admin couldn’t be reached. Try again in a moment.';
};

/** Links to the other admin pages. */
export function AdminNav() {
  const here = usePathname();
  return (
    <nav aria-label="Admin pages" className="mb-8">
      <ul className="flex flex-wrap gap-x-6 gap-y-1">
        {ADMIN_PAGES.map((p) => (
          <li key={p.href}>
            <Link
              href={p.href}
              aria-current={here === p.href ? 'page' : undefined}
              className="inline-flex min-h-11 items-center text-foreground underline-offset-4 hover:underline aria-[current=page]:font-semibold"
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
 * The staff gate every admin page shares (D1): api-admin's client for a signed-in Admin or
 * SuperAdmin, or what to tell anyone else. api-admin checks the role again on every call; this
 * only spares others a page of errors. The browser calls api-admin with the person's own token
 * (D31), through the same client as api-user.
 */
export function AdminAccess({
  apiAdminUrl,
  children,
}: {
  apiAdminUrl?: string;
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
        Sign in with an admin account to use this page.
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
  if (role === undefined || !ADMIN_ROLES.has(role)) {
    return (
      <p
        className="rounded-2xl border border-border bg-card p-6"
        data-admin-refused=""
      >
        This page is for admins.
      </p>
    );
  }
  return <>{children(client)}</>;
}
