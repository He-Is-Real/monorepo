'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  AdminAccess,
  problemText,
  WRAPPING_BUTTON,
} from '@/components/admin/admin-access';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/native-select';
import type { ApiUser } from '@/lib/api-user';

type StaffRole = 'Moderator' | 'Admin';

/** The contract's `StaffMember`. */
interface StaffMember {
  email: string;
  role: StaffRole;
  addedBy: string | null;
  addedAt: string;
  baseline: boolean;
}

/** G7: only these can be staff (api-admin and the database check it too). */
const STAFF_EMAIL = /^[a-z0-9._%+-]+@heisreal\.today$/;
const ROLES: StaffRole[] = ['Moderator', 'Admin'];

const day = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
const path = (email: string) => `/v1/admin/staff/${encodeURIComponent(email)}`;

type Loaded =
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | { status: 'ready'; members: StaffMember[] };

type Note = { kind: 'done' | 'error'; text: string } | null;

/**
 * The Staff page (S-1 to S-4, G7, G8 B, G24; Joel 2026-11-11), Admins only (api-admin checks it
 * too): the staff list, adding an @heisreal.today email as a Moderator or an Admin, changing a
 * role and removing someone. api-admin writes each change to Clerk, where roles live, then to the
 * list.
 */
export function AdminStaff({ apiAdminUrl }: { apiAdminUrl?: string }) {
  return (
    <AdminAccess apiAdminUrl={apiAdminUrl}>
      {(client) => <Staff client={client} />}
    </AdminAccess>
  );
}

function Staff({ client }: { client: ApiUser }) {
  const id = useId();
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [note, setNote] = useState<Note>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<StaffRole>('Moderator');
  const [emailError, setEmailError] = useState<string | null>(null);
  const load = useRef(0);
  const noteRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => {
    const mine = ++load.current;
    client.get<{ data: StaffMember[] }>('/v1/admin/staff').then(
      ({ data }) => {
        if (load.current !== mine) return;
        setLoaded(
          data
            ? { status: 'ready', members: data.data }
            : { status: 'failed', message: 'No answer.' },
        );
      },
      (err: unknown) => {
        if (load.current === mine)
          setLoaded({ status: 'failed', message: problemText(err) });
      },
    );
  }, [client]);

  useEffect(() => {
    refresh();
  }, [refresh]);
  useEffect(() => {
    if (note) noteRef.current?.focus();
  }, [note]);
  useEffect(() => {
    if (removing) confirmRef.current?.focus();
  }, [removing]);

  /** Runs one change, then shows `done` (or why not) and reads the list again. */
  async function change(
    work: () => Promise<unknown>,
    done: string,
  ): Promise<boolean> {
    setBusy(true);
    setNote(null);
    try {
      await work();
      setNote({ kind: 'done', text: done });
      return true;
    } catch (err) {
      setNote({ kind: 'error', text: problemText(err) });
      return false;
    } finally {
      setBusy(false);
      refresh();
    }
  }

  function add(event: React.FormEvent) {
    event.preventDefault();
    const address = email.trim().toLowerCase();
    if (!STAFF_EMAIL.test(address)) {
      setEmailError('Enter an @heisreal.today email address.');
      return;
    }
    setEmailError(null);
    void change(
      () => client.command(path(address), { method: 'PUT', body: { role } }),
      `${address} is now ${role === 'Admin' ? 'an Admin' : 'a Moderator'}.`,
    ).then((ok) => ok && setEmail(''));
  }

  if (loaded.status === 'loading') {
    return <p className="text-secondary-text">Loading the staff list…</p>;
  }
  if (loaded.status === 'failed') {
    return (
      <p
        role="alert"
        className="rounded-2xl border border-destructive bg-card p-6"
      >
        {loaded.message}
      </p>
    );
  }

  return (
    <section className="space-y-8">
      {note && (
        <div
          ref={noteRef}
          tabIndex={-1}
          role={note.kind === 'error' ? 'alert' : 'status'}
          className={`rounded-xl border px-4 py-3 [overflow-wrap:anywhere] ${note.kind === 'error' ? 'border-destructive' : 'border-primary'}`}
          data-staff-status={note.kind}
        >
          {note.text}
        </div>
      )}

      <form
        onSubmit={add}
        noValidate
        className="space-y-4 rounded-2xl border border-border bg-card p-4 sm:p-6"
        aria-labelledby={`${id}-add`}
      >
        <h2 id={`${id}-add`} className="text-lg font-semibold">
          Add someone
        </h2>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1">
            <label
              htmlFor={`${id}-email`}
              className="mb-1 block font-medium text-foreground"
            >
              Email
            </label>
            <input
              id={`${id}-email`}
              type="email"
              autoComplete="off"
              value={email}
              aria-invalid={emailError ? true : undefined}
              aria-describedby={`${id}-email-hint${emailError ? ` ${id}-email-error` : ''}`}
              onChange={(e) => setEmail(e.target.value)}
              className="min-h-11 w-full rounded-lg border border-input bg-input-background px-3 py-2 text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none aria-[invalid=true]:border-destructive"
            />
          </div>
          <div>
            <label
              htmlFor={`${id}-role`}
              className="mb-1 block font-medium text-foreground"
            >
              Role
            </label>
            <NativeSelect
              id={`${id}-role`}
              wrapperClassName="w-full sm:w-44"
              value={role}
              onChange={(e) => setRole(e.target.value as StaffRole)}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </NativeSelect>
          </div>
          <Button type="submit" className={WRAPPING_BUTTON} disabled={busy}>
            Add
          </Button>
        </div>
        <p id={`${id}-email-hint`} className="text-sm text-secondary-text">
          Only @heisreal.today addresses. They create an account with that
          address first, then you add them here.
        </p>
        {emailError && (
          <p id={`${id}-email-error`} className="text-sm text-destructive">
            {emailError}
          </p>
        )}
      </form>

      <section aria-labelledby={`${id}-list`} className="space-y-3">
        <h2 id={`${id}-list`} className="text-lg font-semibold">
          Staff
        </h2>
        <ul className="divide-y divide-border rounded-2xl border border-border bg-card">
          {loaded.members.map((m) => (
            <li
              key={m.email}
              className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
              data-staff-member={m.email}
            >
              <div className="min-w-0">
                <p className="font-medium [overflow-wrap:anywhere]">
                  {m.email}
                </p>
                <p className="text-sm text-secondary-text [overflow-wrap:anywhere]">
                  {m.baseline ? 'Baseline admin. ' : ''}
                  Added {m.addedBy
                    ? `by ${m.addedBy}`
                    : 'by the deploy'} on {day(m.addedAt)}.
                </p>
              </div>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <label className="sr-only" htmlFor={`${id}-${m.email}`}>
                  Role for {m.email}
                </label>
                <NativeSelect
                  id={`${id}-${m.email}`}
                  wrapperClassName="w-full sm:w-40"
                  value={m.role}
                  disabled={busy}
                  onChange={(e) => {
                    const next = e.target.value as StaffRole;
                    void change(
                      () =>
                        client.command(path(m.email), {
                          method: 'PUT',
                          body: { role: next },
                        }),
                      `${m.email} is now ${next === 'Admin' ? 'an Admin' : 'a Moderator'}.`,
                    );
                  }}
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </NativeSelect>
                <Button
                  type="button"
                  variant="outline"
                  className={WRAPPING_BUTTON}
                  disabled={busy}
                  aria-label={`Remove ${m.email}`}
                  onClick={() => setRemoving(m.email)}
                >
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {removing && (
        <div
          ref={confirmRef}
          tabIndex={-1}
          role="alertdialog"
          aria-labelledby={`${id}-confirm`}
          className="space-y-4 rounded-2xl border border-primary bg-card p-4 sm:p-6"
        >
          <p id={`${id}-confirm`} className="[overflow-wrap:anywhere]">
            Remove {removing} from the staff? They become a User.
          </p>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Button
              type="button"
              className={WRAPPING_BUTTON}
              onClick={() => {
                const who = removing;
                setRemoving(null);
                void change(
                  () => client.command(path(who), { method: 'DELETE' }),
                  `${who} is no longer staff.`,
                );
              }}
            >
              Yes, remove
            </Button>
            <Button
              type="button"
              variant="outline"
              className={WRAPPING_BUTTON}
              onClick={() => setRemoving(null)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
