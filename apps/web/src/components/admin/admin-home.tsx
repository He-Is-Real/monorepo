'use client';

import { AdminAccess } from '@/components/admin/admin-access';

/**
 * The admin landing page's content: nothing for staff (the staff menu above is the page), and
 * the same refusal the moderation pages give anyone else (D1: Moderators and up).
 */
export function AdminHome({ apiAdminUrl }: { apiAdminUrl?: string }) {
  return (
    <AdminAccess apiAdminUrl={apiAdminUrl} min="Moderator">
      {() => null}
    </AdminAccess>
  );
}
