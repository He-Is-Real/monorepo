'use client';

import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { AdminAccess, problemText } from '@/components/admin/admin-access';
import {
  Button,
  Card,
  Confirm,
  Field,
  FieldError,
  FieldHint,
  FieldLabel,
  Input,
  Heading,
  Notice,
  Select,
  Text,
} from '@heisreal/web-ui';
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
const ROLE_OPTIONS = ROLES.map((r) => ({ value: r, label: r }));

const day = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
const path = (email: string) => `/v1/admin/staff/${encodeURIComponent(email)}`;

type Loaded =
  | { status: 'loading' }
  | { status: 'failed'; message: ReactNode }
  | { status: 'ready'; members: StaffMember[] };

type Note = { kind: 'done' | 'error'; text: ReactNode } | null;

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
  /** The Remove button that opened the step: focus goes back to it after "Cancel" (CD-1 A). */
  const removeButton = useRef<HTMLButtonElement | null>(null);

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
    return <Text tone="quiet">Loading the staff list…</Text>;
  }
  if (loaded.status === 'failed') {
    return (
      <Notice kind="danger" as="p" role="alert">
        {loaded.message}
      </Notice>
    );
  }

  return (
    <section className="space-y-8">
      {note && (
        <Notice
          kind={note.kind === 'error' ? 'danger' : 'success'}
          ref={noteRef}
          tabIndex={-1}
          role={note.kind === 'error' ? 'alert' : 'status'}
          className="outline-none"
          data-staff-status={note.kind}
        >
          {note.text}
        </Notice>
      )}

      <Card asChild className="space-y-4 p-4 sm:p-6">
        <form
          onSubmit={add}
          noValidate

          aria-labelledby={`${id}-add`}
        >
          <Heading level={2} size="sub" id={`${id}-add`}>
            Add someone
          </Heading>
          <Field id={`${id}-email`} hint error={emailError}>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
              <div className="min-w-0 flex-1">
                <FieldLabel>Email</FieldLabel>
                <Input
                  size="standard"
                  type="email"
                  autoComplete="off"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div>
                <FieldLabel htmlFor={`${id}-role`}>Role</FieldLabel>
                <Select
                  id={`${id}-role`}
                  wrapperClassName="w-full sm:w-44"
                  value={role}
                  options={ROLE_OPTIONS}
                  onValueChange={(v) => setRole(v as StaffRole)}
                />
              </div>
              <Button type="submit" wrap disabled={busy}>
                Add
              </Button>
            </div>
            <FieldHint>
              Only @heisreal.today addresses. They create an account with that
              address first, then you add them here.
            </FieldHint>
            <FieldError />
          </Field>
        </form>
      </Card>

      <section aria-labelledby={`${id}-list`} className="space-y-3">
        <Heading level={2} id={`${id}-list`}>
          Staff
        </Heading>
        <Card asChild className="divide-y divide-border">
          <ul>
            {loaded.members.map((m) => (
              <li
                key={m.email}
                className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
                data-staff-member={m.email}
              >
                <div className="min-w-0">
                  <Text weight="bold" className="[overflow-wrap:anywhere]">
                    {m.email}
                  </Text>
                  <Text
                    size="small"
                    tone="quiet"
                    className="[overflow-wrap:anywhere]"
                  >
                    {m.baseline ? 'Baseline admin. ' : ''}
                    Added {m.addedBy
                      ? `by ${m.addedBy}`
                      : 'by the deploy'} on {day(m.addedAt)}.
                  </Text>
                </div>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                  <label className="sr-only" htmlFor={`${id}-${m.email}`}>
                    Role for {m.email}
                  </label>
                  <Select
                    id={`${id}-${m.email}`}
                    wrapperClassName="w-full sm:w-40"
                    value={m.role}
                    options={ROLE_OPTIONS}
                    disabled={busy}
                    onValueChange={(v) => {
                      const next = v as StaffRole;
                      void change(
                        () =>
                          client.command(path(m.email), {
                            method: 'PUT',
                            body: { role: next },
                          }),
                        `${m.email} is now ${next === 'Admin' ? 'an Admin' : 'a Moderator'}.`,
                      );
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    wrap
                    disabled={busy}
                    aria-label={`Remove ${m.email}`}
                    onClick={(e) => {
                      removeButton.current = e.currentTarget;
                      setRemoving(m.email);
                    }}
                  >
                    Remove
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      </section>

      {removing && (
        <Confirm
          question={`Remove ${removing} from the staff?`}
          confirmLabel="Yes, remove"
          onConfirm={() => {
            const who = removing;
            setRemoving(null);
            void change(
              () => client.command(path(who), { method: 'DELETE' }),
              `${who} is no longer staff.`,
            );
          }}
          onCancel={() => setRemoving(null)}
          returnFocus={removeButton}
        >
          <p>They become a User.</p>
        </Confirm>
      )}
    </section>
  );
}
