'use client';

import Form from 'next/form';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AdminAccess,
  useRole,
  WRAPPING_BUTTON,
} from '@/components/admin/admin-access';
import { ThemeLinks } from '@/components/browse/theme-filter';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/native-select';
import type { ApiUser } from '@/lib/api-user';
import type { ThemeCategory } from '@/lib/browse';
import {
  FORMAT_LABEL,
  LIST_STATES,
  type ListItem,
  type ListPage,
  type ListState,
  moderationProblem,
  SINCE_LABEL,
  sentAt,
  stateLabel,
} from './moderation-api';

type Loaded =
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | {
      status: 'ready';
      items: ListItem[];
      next: string | null;
      more?: 'loading' | string;
    };

/** The list's address for a state and theme (the defaults left out). */
export function moderationHref(state: ListState, theme?: string | null) {
  const sp = new URLSearchParams();
  if (state !== 'pending') sp.set('state', state);
  if (theme) sp.set('theme', theme);
  return sp.size ? `/moderation?${sp}` : '/moderation';
}

/**
 * /moderation (MD-3, MD-4: Joel 2026-11-14): the moderators' list of every story that isn't
 * public, the same page for Moderators and Admins (Admins also get drafts never sent). One state
 * at a time, opening on "Waiting for review", oldest first; optionally one theme (the same theme
 * picker as browse). A table, not story cards: state, title, themes and dates; each title opens
 * its review page. "Show more" reads the next page. api-admin checks the role on every call.
 */
export function ModerationList({
  apiAdminUrl,
  categories,
  state,
  theme,
}: {
  apiAdminUrl?: string;
  categories: ThemeCategory[];
  state?: string;
  theme?: string;
}) {
  return (
    <AdminAccess apiAdminUrl={apiAdminUrl} min="Moderator">
      {(client) => (
        <Filtered
          client={client}
          categories={categories}
          state={state}
          theme={theme}
        />
      )}
    </AdminAccess>
  );
}

function Filtered({
  client,
  categories,
  state: asked,
  theme,
}: {
  client: ApiUser;
  categories: ThemeCategory[];
  state?: string;
  theme?: string;
}) {
  const isAdmin = useRole() === 'Admin';
  const states = LIST_STATES.filter((s) => isAdmin || !s.admin);
  // Anything else (or drafts, to a Moderator) opens on the default.
  const state: ListState =
    states.find((s) => s.state === asked)?.state ?? 'pending';
  return (
    <>
      <div className="border-b border-border pb-6">
        <Form
          key={state}
          action="/moderation"
          aria-label="Which stories"
          className="flex flex-wrap items-center gap-3"
        >
          <label htmlFor="moderation-state" className="font-semibold">
            Show
          </label>
          <NativeSelect
            id="moderation-state"
            name="state"
            defaultValue={state}
            wrapperClassName="min-w-0 max-w-full"
            onChange={(e) => e.currentTarget.form?.requestSubmit()}
          >
            {states.map((s) => (
              <option key={s.state} value={s.state}>
                {s.label}
              </option>
            ))}
          </NativeSelect>
          {/* After the state, so the address reads ?state=…&theme=…, as the theme links' do. */}
          {theme && <input type="hidden" name="theme" value={theme} />}
          <Button type="submit" variant="outline" className="h-11 px-5">
            Show
          </Button>
        </Form>
        <ThemeLinks
          categories={categories}
          chosen={theme}
          hrefOf={(id) => moderationHref(state, theme === id ? null : id)}
        />
      </div>
      <Table
        key={`${state}|${theme ?? ''}`}
        client={client}
        state={state}
        theme={theme}
      />
    </>
  );
}

function Table({
  client,
  state,
  theme,
}: {
  client: ApiUser;
  state: ListState;
  theme?: string;
}) {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const load = useRef(0);

  const page = useCallback(
    (cursor: string | null) => {
      const sp = new URLSearchParams({ state });
      if (theme) sp.set('theme', theme);
      if (cursor) sp.set('cursor', cursor);
      return client
        .get<ListPage>(`/v1/moderation/stories?${sp}`)
        .then(({ data }) => {
          if (!data) throw new Error('No answer');
          return data;
        });
    },
    [client, state, theme],
  );

  useEffect(() => {
    const mine = ++load.current;
    page(null).then(
      (p) => {
        if (load.current === mine)
          setLoaded({ status: 'ready', items: p.data, next: p.nextCursor });
      },
      (err: unknown) => {
        if (load.current === mine)
          setLoaded({ status: 'failed', message: moderationProblem(err) });
      },
    );
  }, [page]);

  if (loaded.status === 'loading') {
    return <p className="mt-6 text-secondary-text">Loading the stories…</p>;
  }
  if (loaded.status === 'failed') {
    return (
      <p
        role="alert"
        className="mt-6 rounded-2xl border border-destructive bg-card p-6"
        data-moderation-error=""
      >
        {loaded.message}
      </p>
    );
  }

  const more = () => {
    if (!loaded.next) return;
    const mine = load.current;
    setLoaded({ ...loaded, more: 'loading' });
    page(loaded.next).then(
      (p) => {
        if (load.current === mine)
          setLoaded({
            status: 'ready',
            items: [...loaded.items, ...p.data],
            next: p.nextCursor,
          });
      },
      (err: unknown) => {
        if (load.current === mine)
          setLoaded({ ...loaded, more: moderationProblem(err) });
      },
    );
  };

  const label = LIST_STATES.find((s) => s.state === state)?.label ?? state;
  if (loaded.items.length === 0) {
    return (
      <p
        className="mt-6 rounded-2xl border border-border bg-card p-6"
        data-list-empty=""
      >
        No stories here.
      </p>
    );
  }
  // Below 640 px each row is a card of label/value lines, so nothing scrolls sideways.
  const cell = 'block py-1 sm:table-cell sm:px-3 sm:py-3 sm:align-top';
  const heading = 'sm:hidden text-sm font-semibold text-secondary-text';
  return (
    <section aria-labelledby="list-heading" className="mt-6">
      <h2 id="list-heading" className="sr-only">
        {label}, oldest first
      </h2>
      <table className="block w-full border-collapse text-left sm:table">
        <thead className="sr-only sm:not-sr-only sm:table-header-group">
          <tr className="border-b border-border text-sm text-secondary-text">
            <th scope="col" className="sm:px-3 sm:py-2">
              Title
            </th>
            <th scope="col" className="sm:px-3 sm:py-2">
              State
            </th>
            <th scope="col" className="sm:px-3 sm:py-2">
              Themes
            </th>
            <th scope="col" className="sm:px-3 sm:py-2">
              Dates
            </th>
          </tr>
        </thead>
        <tbody className="block sm:table-row-group" data-list="">
          {loaded.items.map((s) => (
            <tr
              key={s.id}
              className="block border-b border-border py-3 sm:table-row sm:py-0"
              data-list-item={s.id}
            >
              <td className={`${cell} [overflow-wrap:anywhere]`}>
                <Link
                  href={`/moderation/${encodeURIComponent(s.id)}`}
                  className="inline-flex min-h-11 items-center text-lg font-semibold"
                >
                  {s.title}
                </Link>
                <span className="block text-sm text-secondary-text">
                  {FORMAT_LABEL[s.primaryFormat]}
                </span>
              </td>
              <td className={cell} data-list-state="">
                <span className={heading}>State: </span>
                {stateLabel(s.state, s.action)}
              </td>
              <td className={`${cell} [overflow-wrap:anywhere]`}>
                <span className={heading}>Themes: </span>
                {s.themes.length > 0
                  ? s.themes.map((t) => t.name).join(', ')
                  : 'None'}
              </td>
              <td className={`${cell} text-sm`} data-list-dates="">
                <Dates item={s} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {loaded.next && (
        <div className="mt-6 space-y-3">
          {loaded.more && loaded.more !== 'loading' && (
            <p role="alert" className="text-destructive">
              {loaded.more}
            </p>
          )}
          <Button
            type="button"
            variant="outline"
            className={WRAPPING_BUTTON}
            disabled={loaded.more === 'loading'}
            onClick={more}
          >
            {loaded.more === 'loading' ? 'Loading…' : 'Show more'}
          </Button>
        </div>
      )}
    </section>
  );
}

/** When it was sent, when it entered its state, and when it last changed. */
function Dates({ item }: { item: ListItem }) {
  const lines: [string, string][] = [];
  if (item.state !== 'pending' && item.sentAt)
    lines.push(['Sent', item.sentAt]);
  lines.push([SINCE_LABEL[item.state], item.since]);
  if (item.updatedAt !== item.since) lines.push(['Changed', item.updatedAt]);
  return (
    <ul>
      {lines.map(([what, at]) => (
        <li key={what}>
          {what} <time dateTime={at}>{sentAt(at)}</time>
        </li>
      ))}
    </ul>
  );
}
