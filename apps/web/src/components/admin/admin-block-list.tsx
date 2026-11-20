'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { AdminAccess, problemText } from '@/components/admin/admin-access';
import {
  Button,
  Card,
  Field,
  FieldError,
  FieldHint,
  FieldLabel,
  Input,
} from '@heisreal/web-ui';
import type { ApiUser } from '@/lib/api-user';

/** The contract's `BlockedEmail` and `BlockedIp`. */
interface BlockedEmail {
  email: string;
  addedBy: string | null;
  addedAt: string;
}
interface BlockedIp {
  ip: string;
  addedBy: string | null;
  addedAt: string;
}
/** The contract's `BlockList`. */
interface BlockList {
  emails: BlockedEmail[];
  ips: BlockedIp[];
}

type Kind = 'emails' | 'ips';

const day = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
const path = (kind: Kind, value: string) =>
  `/v1/admin/block-list/${kind}/${encodeURIComponent(value)}`;

type Loaded =
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | { status: 'ready'; list: BlockList };

type Note = { kind: 'done' | 'error'; text: string } | null;

/**
 * The Block list page (G21 D, G24; Joel 2026-11-11), Admins only (api-admin checks it too): the
 * blocked emails and IP addresses, adding one and removing one. A blocked email can't create an
 * account or send a story; a blocked IP address can't send a story. `initialIp`: an address to
 * add, from a story's moderation view.
 */
export function AdminBlockList({
  apiAdminUrl,
  initialIp,
}: {
  apiAdminUrl?: string;
  initialIp?: string;
}) {
  return (
    <AdminAccess apiAdminUrl={apiAdminUrl}>
      {(client) => <Blocks client={client} initialIp={initialIp} />}
    </AdminAccess>
  );
}

function Blocks({
  client,
  initialIp,
}: {
  client: ApiUser;
  initialIp?: string;
}) {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [note, setNote] = useState<Note>(null);
  const [busy, setBusy] = useState(false);
  const load = useRef(0);
  const noteRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => {
    const mine = ++load.current;
    client.get<BlockList>('/v1/admin/block-list').then(
      ({ data }) => {
        if (load.current !== mine) return;
        setLoaded(
          data
            ? { status: 'ready', list: data }
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

  const add = (kind: Kind, value: string) =>
    change(
      () => client.command(path(kind, value), { method: 'PUT' }),
      `${value} is blocked.`,
    );
  const remove = (kind: Kind, value: string) =>
    void change(
      () => client.command(path(kind, value), { method: 'DELETE' }),
      `${value} is no longer blocked.`,
    );

  if (loaded.status === 'loading') {
    return <p className="text-secondary-text">Loading the block list…</p>;
  }
  if (loaded.status === 'failed') {
    return (
      <Card asChild tone="destructive" className="p-6">
        <p role="alert">{loaded.message}</p>
      </Card>
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
          data-block-status={note.kind}
        >
          {note.text}
        </div>
      )}
      <BlockPart
        kind="emails"
        heading="Emails"
        label="Email"
        hint="They can’t create an account or send a story. Someone who already has an account keeps it."
        empty="No emails are blocked."
        entries={loaded.list.emails.map((e) => ({ value: e.email, ...e }))}
        busy={busy}
        onAdd={add}
        onRemove={remove}
      />
      <BlockPart
        kind="ips"
        heading="IP addresses"
        label="IP address"
        hint="No story can be sent from this exact address. A story’s moderation view shows the address it was sent from, for 30 days."
        empty="No IP addresses are blocked."
        initial={initialIp}
        entries={loaded.list.ips.map((e) => ({ value: e.ip, ...e }))}
        busy={busy}
        onAdd={add}
        onRemove={remove}
      />
    </section>
  );
}

/** One part of the list (emails or IP addresses): its add form, then its entries. */
function BlockPart({
  kind,
  heading,
  label,
  hint,
  empty,
  initial = '',
  entries,
  busy,
  onAdd,
  onRemove,
}: {
  kind: Kind;
  heading: string;
  label: string;
  hint: string;
  empty: string;
  initial?: string;
  entries: { value: string; addedBy: string | null; addedAt: string }[];
  busy: boolean;
  onAdd: (kind: Kind, value: string) => Promise<boolean>;
  onRemove: (kind: Kind, value: string) => void;
}) {
  const id = useId();
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const text = value.trim();
    if (!text) {
      setError(
        kind === 'emails' ? 'Enter an email address.' : 'Enter an IP address.',
      );
      return;
    }
    setError(null);
    void onAdd(kind, text).then((ok) => ok && setValue(''));
  }

  return (
    <section aria-labelledby={`${id}-heading`} className="space-y-4">
      <h2 id={`${id}-heading`} className="text-lg font-semibold">
        {heading}
      </h2>
      <Card asChild className="space-y-3 p-4 sm:p-6">
        <form onSubmit={submit} noValidate>
          <Field id={`${id}-value`} hint error={error}>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
              <div className="min-w-0 flex-1">
                <FieldLabel>{label}</FieldLabel>
                <Input
                  size="form"
                  type={kind === 'emails' ? 'email' : 'text'}
                  inputMode={kind === 'emails' ? 'email' : 'text'}
                  autoComplete="off"
                  spellCheck={false}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                />
              </div>
              <Button type="submit" wrap disabled={busy}>
                Block
              </Button>
            </div>
            <FieldHint>{hint}</FieldHint>
            <FieldError />
          </Field>
        </form>
      </Card>
      {entries.length === 0 ? (
        <p className="text-secondary-text">{empty}</p>
      ) : (
        <Card asChild className="divide-y divide-border">
          <ul>
            {entries.map((e) => (
              <li
                key={e.value}
                className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
                data-blocked={e.value}
              >
                <div className="min-w-0">
                  <p className="font-medium [overflow-wrap:anywhere]">
                    {e.value}
                  </p>
                  <p className="text-sm text-secondary-text [overflow-wrap:anywhere]">
                    Blocked {e.addedBy ? `by ${e.addedBy} ` : ''}on{' '}
                    {day(e.addedAt)}.
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  wrap
                  disabled={busy}
                  aria-label={`Unblock ${e.value}`}
                  onClick={() => onRemove(kind, e.value)}
                >
                  Unblock
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </section>
  );
}
