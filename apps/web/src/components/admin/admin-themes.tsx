'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  AdminAccess,
  problemText,
  WRAPPING_BUTTON,
} from '@/components/admin/admin-access';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/native-select';
import { type ApiUser, StaleVersion } from '@/lib/api-user';

/** The contract's `Tag`, as api-admin lists them. */
interface Theme {
  slug: string;
  name: string;
  version: number;
}

/** The contract's `AdminMainThemes`. */
interface MainThemes {
  version: number;
  mainThemes: string[];
  mainThemesCount: number;
}

type Loaded =
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | { status: 'ready'; themes: Theme[]; main: MainThemes };

const NAME_MAX = 40;

const input =
  'min-h-11 w-full rounded-lg border border-input bg-input-background px-3 py-2 text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none aria-[invalid=true]:border-destructive';
const small =
  'inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-border px-3 text-sm text-foreground hover:border-teal aria-disabled:cursor-not-allowed aria-disabled:opacity-50 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none';

/**
 * The themes for staff (O5, Joel 2026-10-31), Admin and above (api-admin checks it too): add a
 * theme, rename one in place (stories show the new name at once; themes are never deleted), and
 * choose the main themes people see first, their order and how many.
 */
export function AdminThemes({ apiAdminUrl }: { apiAdminUrl?: string }) {
  return (
    <AdminAccess apiAdminUrl={apiAdminUrl}>
      {(client) => <Themes client={client} />}
    </AdminAccess>
  );
}

function Themes({ client }: { client: ApiUser }) {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  // Kept here: saving re-reads the main themes, which starts their form again.
  const [mainSaved, setMainSaved] = useState(false);
  const load = useRef(0);

  const refresh = useCallback(() => {
    const mine = ++load.current;
    Promise.all([
      client.get<{ data: Theme[] }>('/v1/admin/themes'),
      client.get<MainThemes>('/v1/admin/main-themes'),
    ]).then(
      ([themes, main]) => {
        if (load.current !== mine) return;
        setLoaded(
          themes.data && main.data
            ? { status: 'ready', themes: themes.data.data, main: main.data }
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

  if (loaded.status === 'loading') {
    return <p className="text-secondary-text">Loading the themes…</p>;
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
    <div className="space-y-12">
      <MainThemesForm
        key={loaded.main.version}
        themes={loaded.themes}
        main={loaded.main}
        client={client}
        reload={refresh}
        saved={mainSaved}
        setSaved={setMainSaved}
      />
      <AllThemes themes={loaded.themes} client={client} reload={refresh} />
    </div>
  );
}

/** A message under a form: done, an error, or another admin's change (reload). */
type Note =
  | { kind: 'done'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'stale'; text: string }
  | null;

function NoteLine({ note, reload }: { note: Note; reload: () => void }) {
  if (!note) return null;
  return (
    <div
      role={note.kind === 'done' ? 'status' : 'alert'}
      className={`space-y-3 rounded-xl border px-4 py-3 ${note.kind === 'done' ? 'border-primary' : 'border-destructive'}`}
      data-note={note.kind}
    >
      <p>{note.text}</p>
      {note.kind === 'stale' && (
        <Button type="button" className={WRAPPING_BUTTON} onClick={reload}>
          Reload
        </Button>
      )}
    </div>
  );
}

function MainThemesForm({
  themes,
  main,
  client,
  reload,
  saved,
  setSaved,
}: {
  themes: Theme[];
  main: MainThemes;
  client: ApiUser;
  reload: () => void;
  saved: boolean;
  setSaved: (saved: boolean) => void;
}) {
  const id = useId();
  const [order, setOrder] = useState(main.mainThemes);
  const [count, setCount] = useState(String(main.mainThemesCount));
  const [adding, setAdding] = useState('');
  const [countError, setCountError] = useState<string | null>(null);
  const [problem, setProblem] = useState<Note>(null);
  const [busy, setBusy] = useState(false);
  const note: Note =
    problem ??
    (saved
      ? { kind: 'done', text: 'Saved. People see the new main themes now.' }
      : null);
  const setNote = (next: Note) => {
    setProblem(next);
    setSaved(false);
  };
  const name = (slug: string) =>
    themes.find((t) => t.slug === slug)?.name ?? slug;
  const others = themes.filter((t) => !order.includes(t.slug));
  const shownCount = Number(count);
  const valid = /^\d+$/.test(count.trim()) && shownCount >= 1;

  const move = (i: number, by: -1 | 1) => {
    const j = i + by;
    if (j < 0 || j >= order.length) return;
    const next = [...order];
    [next[i], next[j]] = [next[j], next[i]];
    setOrder(next);
    setNote(null);
  };

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) {
      setCountError('Enter a whole number, 1 or more.');
      return;
    }
    setCountError(null);
    setBusy(true);
    try {
      await client.command('/v1/admin/main-themes', {
        method: 'PUT',
        body: { mainThemes: order, mainThemesCount: Number(count.trim()) },
        version: main.version,
      });
      setNote(null);
      setSaved(true);
      reload();
    } catch (err) {
      setNote(
        err instanceof StaleVersion
          ? {
              kind: 'stale',
              text: 'Someone else changed the main themes while you were editing, so yours weren’t saved. Reload to see theirs, then make your changes again.',
            }
          : { kind: 'error', text: problemText(err) },
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby={`${id}-title`} className="space-y-5">
      <h2 id={`${id}-title`} className="text-xl font-semibold">
        Main themes
      </h2>
      <p className="max-w-measure text-secondary-text">
        People see these first, in this order, when they choose themes for a
        story or browse stories. Every other theme is behind “More themes”.
      </p>
      <form onSubmit={save} noValidate className="space-y-5">
        <div>
          <label
            htmlFor={`${id}-count`}
            className="mb-1 block font-medium text-foreground"
          >
            How many main themes people see
          </label>
          <input
            id={`${id}-count`}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={count}
            aria-invalid={countError ? true : undefined}
            aria-describedby={countError ? `${id}-count-error` : undefined}
            onChange={(e) => {
              setCount(e.target.value);
              setNote(null);
            }}
            className={`${input} max-w-36`}
          />
          {countError && (
            <p
              id={`${id}-count-error`}
              className="mt-1 text-sm text-destructive"
            >
              {countError}
            </p>
          )}
        </div>

        {order.length === 0 ? (
          <p className="text-secondary-text" data-main-empty="">
            No main themes yet, so people see every theme at once.
          </p>
        ) : (
          <ol className="space-y-2" aria-label="Main themes, in order">
            {order.map((slug, i) => {
              const hidden = valid && i >= shownCount;
              const label = name(slug);
              return (
                <li
                  key={slug}
                  data-main-theme={slug}
                  className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-2"
                >
                  <span className="min-w-0 flex-1 px-2 [overflow-wrap:anywhere]">
                    <span className="text-secondary-text">{i + 1}.</span>{' '}
                    {label}
                    {hidden && (
                      <span className="block text-sm text-secondary-text">
                        Not shown first: beyond the number above
                      </span>
                    )}
                  </span>
                  <span className="flex gap-2">
                    <button
                      type="button"
                      className={small}
                      aria-label={`Move ${label} up`}
                      aria-disabled={i === 0 || undefined}
                      onClick={() => move(i, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className={small}
                      aria-label={`Move ${label} down`}
                      aria-disabled={i === order.length - 1 || undefined}
                      onClick={() => move(i, 1)}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className={small}
                      aria-label={`Remove ${label} from the main themes`}
                      onClick={() => {
                        setOrder(order.filter((s) => s !== slug));
                        setNote(null);
                      }}
                    >
                      Remove
                    </button>
                  </span>
                </li>
              );
            })}
          </ol>
        )}

        {others.length > 0 && (
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-0 flex-1 sm:max-w-sm">
              <label
                htmlFor={`${id}-add`}
                className="mb-1 block font-medium text-foreground"
              >
                Add a main theme
              </label>
              <NativeSelect
                id={`${id}-add`}
                value={adding}
                onChange={(e) => setAdding(e.target.value)}
                className="w-full"
              >
                <option value="">Choose a theme</option>
                {others.map((t) => (
                  <option key={t.slug} value={t.slug}>
                    {t.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <Button
              type="button"
              variant="outline"
              className={WRAPPING_BUTTON}
              disabled={!adding}
              onClick={() => {
                setOrder([...order, adding]);
                setAdding('');
                setNote(null);
              }}
            >
              Add to the list
            </Button>
          </div>
        )}

        <Button type="submit" className={WRAPPING_BUTTON} disabled={busy}>
          {busy ? 'Saving…' : 'Save main themes'}
        </Button>
      </form>
      <NoteLine
        note={note}
        reload={() => {
          setNote(null);
          reload();
        }}
      />
    </section>
  );
}

function AllThemes({
  themes,
  client,
  reload,
}: {
  themes: Theme[];
  client: ApiUser;
  reload: () => void;
}) {
  const id = useId();
  const [name, setName] = useState('');
  const [note, setNote] = useState<Note>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.replace(/\s+/g, ' ').trim();
    if (!trimmed) {
      setNote({ kind: 'error', text: 'Enter a name for the theme.' });
      return;
    }
    setBusy(true);
    try {
      await client.command('/v1/admin/themes', {
        method: 'POST',
        body: { name: trimmed },
      });
      setName('');
      setNote({ kind: 'done', text: `Added “${trimmed}”.` });
      reload();
    } catch (err) {
      setNote({ kind: 'error', text: problemText(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby={`${id}-title`} className="space-y-5">
      <h2 id={`${id}-title`} className="text-xl font-semibold">
        All themes
      </h2>
      <p className="max-w-measure text-secondary-text">
        Themes can’t be deleted. Renaming one changes it on every story that has
        it.
      </p>
      <form
        onSubmit={add}
        noValidate
        className="flex flex-wrap items-end gap-3"
      >
        <div className="min-w-0 flex-1 sm:max-w-sm">
          <label
            htmlFor={`${id}-new`}
            className="mb-1 block font-medium text-foreground"
          >
            New theme
          </label>
          <input
            id={`${id}-new`}
            type="text"
            autoComplete="off"
            maxLength={NAME_MAX}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setNote(null);
            }}
            className={input}
          />
        </div>
        <Button type="submit" className={WRAPPING_BUTTON} disabled={busy}>
          Add theme
        </Button>
      </form>
      <NoteLine note={note} reload={reload} />
      <ul className="space-y-2" aria-label="All themes">
        {themes.map((t) =>
          editing === t.slug ? (
            <RenameTheme
              key={t.slug}
              theme={t}
              client={client}
              done={(renamed) => {
                setEditing(null);
                if (renamed) {
                  setNote({ kind: 'done', text: `Renamed to “${renamed}”.` });
                  reload();
                }
              }}
              reload={() => {
                setEditing(null);
                reload();
              }}
            />
          ) : (
            <li
              key={t.slug}
              data-theme={t.slug}
              className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-2"
            >
              <span className="min-w-0 flex-1 px-2 [overflow-wrap:anywhere]">
                {t.name}
              </span>
              <button
                type="button"
                className={small}
                aria-label={`Rename ${t.name}`}
                onClick={() => setEditing(t.slug)}
              >
                Rename
              </button>
            </li>
          ),
        )}
      </ul>
    </section>
  );
}

function RenameTheme({
  theme,
  client,
  done,
  reload,
}: {
  theme: Theme;
  client: ApiUser;
  done: (renamed: string | null) => void;
  reload: () => void;
}) {
  const id = useId();
  const [name, setName] = useState(theme.name);
  const [note, setNote] = useState<Note>(null);
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => field.current?.focus(), []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.replace(/\s+/g, ' ').trim();
    if (!trimmed) {
      setNote({ kind: 'error', text: 'Enter a name for the theme.' });
      return;
    }
    if (trimmed === theme.name) return done(null);
    setBusy(true);
    try {
      await client.command(`/v1/admin/themes/${theme.slug}`, {
        method: 'PATCH',
        mergePatch: true,
        body: { name: trimmed },
        version: theme.version,
      });
      done(trimmed);
    } catch (err) {
      setNote(
        err instanceof StaleVersion
          ? {
              kind: 'stale',
              text: 'Someone else changed this theme while you were editing. Reload to see it, then rename it again.',
            }
          : { kind: 'error', text: problemText(err) },
      );
      setBusy(false);
    }
  }

  return (
    <li
      data-theme={theme.slug}
      className="space-y-3 rounded-xl border border-primary bg-card p-3"
    >
      <form
        onSubmit={save}
        noValidate
        onKeyDown={(e) => {
          if (e.key === 'Escape') done(null);
        }}
        className="flex flex-wrap items-end gap-3"
      >
        <div className="min-w-0 flex-1 sm:max-w-sm">
          <label
            htmlFor={`${id}-name`}
            className="mb-1 block font-medium text-foreground"
          >
            New name for {theme.name}
          </label>
          <input
            ref={field}
            id={`${id}-name`}
            type="text"
            autoComplete="off"
            maxLength={NAME_MAX}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={input}
          />
        </div>
        <div className="flex flex-wrap gap-3">
          <Button type="submit" className={WRAPPING_BUTTON} disabled={busy}>
            Save name
          </Button>
          <Button
            type="button"
            variant="outline"
            className={WRAPPING_BUTTON}
            onClick={() => done(null)}
          >
            Cancel
          </Button>
        </div>
      </form>
      <NoteLine note={note} reload={reload} />
    </li>
  );
}
