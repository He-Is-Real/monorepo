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
  Field,
  FieldError,
  FieldHint,
  FieldLabel,
  Input,
  Heading,
  Notice,
  Text,
  Textarea,
} from '@heisreal/web-ui';
import type { ApiUser } from '@/lib/api-user';

/** The contract's `BlockedEmail` and `BlockedIp`. */
interface BlockedEmail {
  email: string;
  addedBy: string | null;
  addedAt: string;
  note: string | null;
}
interface BlockedIp {
  ip: string;
  addedBy: string | null;
  addedAt: string;
  note: string | null;
}
/** The contract's `BlockList`. */
interface BlockList {
  emails: BlockedEmail[];
  ips: BlockedIp[];
}

type Kind = 'emails' | 'ips';

/** A block note's longest length, in characters (BN-2, Joel 2026-11-22; api-admin checks it too). */
export const BLOCK_NOTE_MAX = 500;

/** Trims as api-admin and the database do: Unicode White_Space at either end. */
const trimNote = (note: string) =>
  note.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');

/** A note's length in characters (code points, as api-admin counts), once trimmed. */
const noteLength = (note: string) => [...trimNote(note)].length;

/** Whether a note is over the limit: its form says so and doesn't send it. */
export const blockNoteTooLong = (note: string) =>
  noteLength(note) > BLOCK_NOTE_MAX;

/** The note a Block command sends: trimmed, and none when blank (BN-2: a note is optional). */
export const blockNoteBody = (note: string) => ({
  note: trimNote(note) || null,
});

/**
 * The note box for a block (BN-1 C, BN-2, BN-6 A; Joel 2026-11-22): "Why is it blocked?", with the
 * grey suggestion and, under it, the hint that stays visible. Optional; at most 500 characters.
 * Used on the Block list page (blocking, and Edit note) and in a story's moderation view (BN-7).
 */
export function BlockNoteField({
  value,
  onChange,
  textareaRef,
}: {
  value: string;
  onChange: (value: string) => void;
  textareaRef?: React.Ref<HTMLTextAreaElement>;
}) {
  const id = useId();
  const length = noteLength(value);
  // No native maxLength: it counts UTF-16 units, so an emoji would count twice.
  const over = length > BLOCK_NOTE_MAX;
  return (
    <Field
      id={`${id}-note`}
      hint
      error={
        over
          ? `Keep the note to ${BLOCK_NOTE_MAX.toLocaleString('en-GB')} characters or fewer.`
          : null
      }
      describedBy={`${id}-count`}
    >
      <FieldLabel>Why is it blocked?</FieldLabel>
      <Textarea
        ref={textareaRef}
        className="min-h-24"
        placeholder="Note the reason, so other Admins know why."
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <FieldHint className="mt-1">
        Only Admins see this note. Write only what explains the block, as if the
        person could read it. Don’t copy their story.
      </FieldHint>
      <Text id={`${id}-count`} size="small" tone="quiet" className="mt-1">
        {length.toLocaleString('en-GB')} /{' '}
        {BLOCK_NOTE_MAX.toLocaleString('en-GB')} characters
      </Text>
      <FieldError className="mt-1" />
    </Field>
  );
}

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
  | { status: 'failed'; message: ReactNode }
  | { status: 'ready'; list: BlockList };

type Note = { kind: 'done' | 'error'; text: ReactNode } | null;

/**
 * The Block list page (G21 D, G24; Joel 2026-11-11), Admins only (api-admin checks it too): the
 * blocked emails and IP addresses, each with an optional note on why (BN-1 to BN-6, Joel
 * 2026-11-22), adding one, changing its note and removing one. A blocked email can't create an
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

  const add = (kind: Kind, value: string, note: string) =>
    change(
      () =>
        client.command(path(kind, value), {
          method: 'PUT',
          body: blockNoteBody(note),
        }),
      `${value} is blocked.`,
    );
  /** BN-4 A: any Admin changes the note; blank clears it ("No note yet"). */
  const saveNote = (kind: Kind, value: string, note: string) =>
    change(
      () =>
        client.command(path(kind, value), {
          method: 'PATCH',
          mergePatch: true,
          body: blockNoteBody(note),
        }),
      `The note on ${value} is saved.`,
    );
  const remove = (kind: Kind, value: string) =>
    void change(
      () => client.command(path(kind, value), { method: 'DELETE' }),
      `${value} is no longer blocked.`,
    );

  if (loaded.status === 'loading') {
    return <Text tone="quiet">Loading the block list…</Text>;
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
          data-block-status={note.kind}
        >
          {note.text}
        </Notice>
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
        onSaveNote={saveNote}
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
        onSaveNote={saveNote}
        onRemove={remove}
      />
    </section>
  );
}

interface Entry {
  value: string;
  addedBy: string | null;
  addedAt: string;
  note: string | null;
}

/**
 * One entry: the value, its note on its own line in full (BN-3 A; "No note yet" without one,
 * BN-2), who blocked it and when, then Edit note (BN-4 A) and Unblock.
 */
function BlockEntry({
  kind,
  entry: e,
  busy,
  onSaveNote,
  onRemove,
}: {
  kind: Kind;
  entry: Entry;
  busy: boolean;
  onSaveNote: (kind: Kind, value: string, note: string) => Promise<boolean>;
  onRemove: (kind: Kind, value: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const open = editing !== null;
  // Opening the box moves to it.
  useEffect(() => {
    if (open) boxRef.current?.focus();
  }, [open]);
  return (
    <li className="space-y-3 p-4" data-blocked={e.value}>
      <div className="min-w-0 space-y-1">
        <Text weight="bold" className="[overflow-wrap:anywhere]">
          {e.value}
        </Text>
        {editing === null &&
          (e.note ? (
            <p
              className="whitespace-pre-line [overflow-wrap:anywhere]"
              data-block-note=""
            >
              {e.note}
            </p>
          ) : (
            <Text tone="quiet" italic data-block-note-empty="">
              No note yet
            </Text>
          ))}
        <Text size="small" tone="quiet" className="[overflow-wrap:anywhere]">
          Blocked {e.addedBy ? `by ${e.addedBy} ` : ''}on {day(e.addedAt)}.
        </Text>
      </div>
      {editing !== null ? (
        <form
          className="space-y-3"
          aria-label={`Edit the note on ${e.value}`}
          onSubmit={(event) => {
            event.preventDefault();
            if (blockNoteTooLong(editing)) return;
            void onSaveNote(kind, e.value, editing).then(
              (ok) => ok && setEditing(null),
            );
          }}
        >
          <BlockNoteField
            value={editing}
            onChange={setEditing}
            textareaRef={boxRef}
          />
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button type="submit" wrap disabled={busy}>
              Save
            </Button>
            <Button
              type="button"
              variant="outline"
              wrap
              disabled={busy}
              onClick={() => setEditing(null)}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            type="button"
            variant="outline"
            wrap
            disabled={busy}
            aria-label={`Edit the note on ${e.value}`}
            onClick={() => setEditing(e.note ?? '')}
          >
            Edit note
          </Button>
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
        </div>
      )}
    </li>
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
  onSaveNote,
  onRemove,
}: {
  kind: Kind;
  heading: string;
  label: string;
  hint: string;
  empty: string;
  initial?: string;
  entries: Entry[];
  busy: boolean;
  onAdd: (kind: Kind, value: string, note: string) => Promise<boolean>;
  onSaveNote: (kind: Kind, value: string, note: string) => Promise<boolean>;
  onRemove: (kind: Kind, value: string) => void;
}) {
  const id = useId();
  const [value, setValue] = useState(initial);
  const [note, setNote] = useState('');
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
    if (blockNoteTooLong(note)) return;
    void onAdd(kind, text, note).then((ok) => {
      if (ok) {
        setValue('');
        setNote('');
      }
    });
  }

  return (
    <section aria-labelledby={`${id}-heading`} className="space-y-4">
      <Heading level={2} id={`${id}-heading`}>
        {heading}
      </Heading>
      <Card asChild className="space-y-4 p-4 sm:p-6">
        <form onSubmit={submit} noValidate>
          <Field id={`${id}-value`} hint error={error}>
            <div>
              <FieldLabel>{label}</FieldLabel>
              <Input
                size="standard"
                type={kind === 'emails' ? 'email' : 'text'}
                inputMode={kind === 'emails' ? 'email' : 'text'}
                autoComplete="off"
                spellCheck={false}
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
              <FieldHint className="mt-1">{hint}</FieldHint>
              <FieldError className="mt-1" />
            </div>
          </Field>
          <div>
            <BlockNoteField value={note} onChange={setNote} />
          </div>
          <Button type="submit" wrap disabled={busy}>
            Block
          </Button>
        </form>
      </Card>
      {entries.length === 0 ? (
        <Text tone="quiet">{empty}</Text>
      ) : (
        <Card asChild className="divide-y divide-border">
          <ul>
            {entries.map((e) => (
              <BlockEntry
                key={e.value}
                kind={kind}
                entry={e}
                busy={busy}
                onSaveNote={onSaveNote}
                onRemove={onRemove}
              />
            ))}
          </ul>
        </Card>
      )}
    </section>
  );
}
