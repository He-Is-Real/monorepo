'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  type MouseEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { AdminAccess, useRole } from '@/components/admin/admin-access';
import {
  type StoryFormat as Format,
  toggleTheme,
} from '@heisreal/story-filters';
import { Button, Card, RadioGroup, SearchBox } from '@heisreal/web-ui';
import { ThemeLinks } from '@/components/browse/theme-filter';
import { FormatSelect } from '@/components/story-filters/format-select';
import type { ApiUser } from '@/lib/api-user';
import type { ThemeCategory } from '@/lib/browse';
import {
  activeFilters,
  FORMAT_LABEL,
  LIST_STATES,
  type ListCounts,
  type ListFilters,
  type ListItem,
  type ListPage,
  listQuery,
  listTime,
  moderationHref,
  moderationProblem,
  SORTS,
  stateLabel,
  waitingAlert,
  waitingFor,
} from './moderation-api';

type Loaded =
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | {
      status: 'ready';
      items: ListItem[];
      next: string | null;
      /** When the page was read: the Waiting column counts from here (no live updates, OQ-2). */
      now: number;
      more?: 'loading' | string;
    };

/**
 * /moderation (MD-3, MD-4: Joel 2026-11-14; MQ-1 E, OQ-2, OQ-3 A: Joel 2026-11-17): the
 * moderators' list of every story that isn't public, the same page for Moderators and Admins
 * (Admins also get drafts never sent). The states are tabs across the top, each with its count;
 * the search, sort, format (with counts) and theme sit in a side panel, the format and theme
 * filtering as browse does with browse's own controls (revised OQ-2, Joel 2026-11-19); the list
 * is one line per story (from 1280 px; below that, one small card each, with the panel folded
 * into "Filters and sort"). Everything the list shows is in the address. "Show more" reads the
 * next page. api-admin checks the role on every call.
 */
export function ModerationList({
  apiAdminUrl,
  categories,
  filters,
}: {
  apiAdminUrl?: string;
  categories: ThemeCategory[];
  filters: ListFilters;
}) {
  return (
    <AdminAccess apiAdminUrl={apiAdminUrl} min="Moderator">
      {(client) => (
        <Filtered client={client} categories={categories} asked={filters} />
      )}
    </AdminAccess>
  );
}

function Filtered({
  client,
  categories,
  asked,
}: {
  client: ApiUser;
  categories: ThemeCategory[];
  asked: ListFilters;
}) {
  const isAdmin = useRole() === 'Admin';
  const states = LIST_STATES.filter((s) => isAdmin || !s.admin);
  // Anything else (or drafts, to a Moderator) opens on the default.
  const filters: ListFilters = states.some((s) => s.state === asked.state)
    ? asked
    : { ...asked, state: 'pending' };
  const query = listQuery(filters).toString();

  // The choices made but not yet in the address: two quick choices both count, each navigation
  // building on the one before rather than on the address it hasn't reached yet (Codex round 1).
  // `path` is the address they started from and each one pushed since: once the address reaches
  // the last, or turns into one not on the path (Back, Forward), the
  // address wins again.
  const router = useRouter();
  const [pending, setPending] = useState<{
    filters: ListFilters;
    path: string[];
  } | null>(null);
  const here = moderationHref(filters);
  if (
    pending &&
    (!pending.path.includes(here) ||
      pending.path[pending.path.length - 1] === here)
  )
    setPending(null);
  const view = pending?.filters ?? filters;
  const go = (next: Partial<ListFilters>) => {
    const f = { ...view, ...next };
    const href = moderationHref(f);
    setPending({ filters: f, path: [...(pending?.path ?? [here]), href] });
    router.push(href, { scroll: false });
  };
  // A state tab or Clear filters link is a choice too, its link doing the navigating: it becomes
  // the pending choice, so a filter or sort chosen before its page loads builds on it (Codex
  // round 2). When it leads back to the address the choices started from, that address is
  // already on the path, so the pending choices are dropped instead of outliving it. A click
  // that opens a new browser tab changes nothing here.
  const follow = (f: ListFilters, e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
      return;
    const href = moderationHref(f);
    setPending(
      href === here
        ? null
        : { filters: f, path: [...(pending?.path ?? [here]), href] },
    );
  };
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  // The counts stay as last read until the next answer (OQ-2: they change when the list reloads).
  const [counts, setCounts] = useState<ListCounts | null>(null);
  const load = useRef(0);

  const page = useCallback(
    (cursor: string | null) => {
      const sp = new URLSearchParams(query);
      if (cursor) sp.set('cursor', cursor);
      return client
        .get<ListPage>(`/v1/moderation/stories?${sp}`)
        .then(({ data }) => {
          if (!data) throw new Error('No answer');
          return data;
        });
    },
    [client, query],
  );

  useEffect(() => {
    const mine = ++load.current;
    setLoaded({ status: 'loading' });
    page(null).then(
      (p) => {
        if (load.current !== mine) return;
        setCounts(p.counts);
        setLoaded({
          status: 'ready',
          items: p.data,
          next: p.nextCursor,
          now: Date.now(),
        });
      },
      (err: unknown) => {
        if (load.current === mine)
          setLoaded({ status: 'failed', message: moderationProblem(err) });
      },
    );
  }, [page]);

  const more = () => {
    if (loaded.status !== 'ready' || !loaded.next) return;
    const mine = load.current;
    const before = loaded;
    setLoaded({ ...before, more: 'loading' });
    page(before.next).then(
      (p) => {
        if (load.current === mine)
          setLoaded({
            ...before,
            items: [...before.items, ...p.data],
            next: p.nextCursor,
            more: undefined,
          });
      },
      (err: unknown) => {
        if (load.current === mine)
          setLoaded({ ...before, more: moderationProblem(err) });
      },
    );
  };

  // The list column is never wider than 1200 px (Joel, 2026-11-17): on the widest screens the
  // panel and list together stop at 15 rem + 2.5 rem + 1200 px, centred (OQ-4 D).
  return (
    <div className="mx-auto 2xl:max-w-[calc(17.5rem+1200px)]" data-list-page="">
      <StateTabs
        filters={view}
        states={states}
        counts={counts}
        follow={follow}
      />
      <div className="mt-6 xl:grid xl:grid-cols-[13rem_minmax(0,1fr)] xl:gap-8 2xl:grid-cols-[15rem_minmax(0,1fr)] 2xl:gap-10">
        <SidePanel
          filters={view}
          categories={categories}
          counts={counts}
          go={go}
          follow={follow}
        />
        <div className="min-w-0" data-list-column="">
          <List filters={filters} loaded={loaded} more={more} follow={follow} />
        </div>
      </div>
    </div>
  );
}

/** The states as tabs (links, so Back and a shared address work), each with its count. */
function StateTabs({
  filters,
  states,
  counts,
  follow,
}: {
  filters: ListFilters;
  states: readonly (typeof LIST_STATES)[number][];
  counts: ListCounts | null;
  follow: (to: ListFilters, e: MouseEvent<HTMLAnchorElement>) => void;
}) {
  return (
    <nav aria-label="Story states" className="border-b border-border">
      {/* Phones scroll the tabs sideways, never the page. */}
      <ul
        className="relative -mb-px flex gap-1 overflow-x-auto"
        data-state-tabs=""
      >
        {states.map((s) => {
          const on = s.state === filters.state;
          const count = counts?.states[s.state];
          return (
            <li key={s.state} className="shrink-0">
              <Link
                href={moderationHref({ ...filters, state: s.state })}
                onClick={(e) => follow({ ...filters, state: s.state }, e)}
                aria-current={on ? 'page' : undefined}
                scroll={false}
                data-state-tab={s.state}
                className={`inline-flex min-h-11 items-center gap-2 border-b-[3px] px-3 py-2 whitespace-nowrap transition-colors sm:px-4 ${
                  on
                    ? 'border-brand font-semibold text-foreground'
                    : 'border-transparent text-secondary-text hover:text-foreground'
                }`}
              >
                {s.label}
                {count !== undefined && (
                  <span
                    data-state-count=""
                    className="rounded-full bg-surface px-2 text-xs leading-5 font-semibold text-secondary-text"
                  >
                    <span className="sr-only">(</span>
                    {count}
                    <span className="sr-only">)</span>
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

const SECTION_HEADING =
  'mb-2 block text-xs font-semibold tracking-wide text-secondary-text uppercase';

/**
 * The search, sort, format and theme (MQ-1 E; the format and theme are browse's own controls and
 * filter, revised OQ-2, Joel 2026-11-19): beside the list from 1280 px; below that, folded into a
 * "Filters and sort" button. Each change goes to the address.
 */
function SidePanel({
  filters,
  categories,
  counts,
  go,
  follow,
}: {
  filters: ListFilters;
  categories: ThemeCategory[];
  counts: ListCounts | null;
  go: (next: Partial<ListFilters>) => void;
  follow: (to: ListFilters, e: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const n = activeFilters(filters);

  return (
    <div className="mb-6 xl:mb-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`${id}-panel`}
        onClick={() => setOpen(!open)}
        data-filters-toggle=""
        className="inline-flex min-h-11 w-full items-center justify-between gap-2 rounded-lg border border-input bg-input-background px-4 text-left font-medium xl:hidden"
      >
        Filters and sort ({n})
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          className={`size-4 fill-none stroke-current transition-transform motion-reduce:transition-none ${open ? 'rotate-180' : ''}`}
          strokeWidth="2"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      <section
        id={`${id}-panel`}
        aria-label="Filters and sort"
        data-filters=""
        className={`${open ? 'block' : 'hidden'} mt-4 space-y-6 xl:mt-0 xl:block`}
      >
        <Search key={filters.q ?? ''} q={filters.q} go={go} />

        {/* The shared radio buttons: the Stories page's sort looks and works the same. */}
        <RadioGroup
          legend="Sort"
          options={SORTS.map((s) => ({ value: s.sort, label: s.label }))}
          value={filters.sort}
          onValueChange={(v) => go({ sort: v as ListFilters['sort'] })}
        />

        <div>
          <FormatSelect
            id={`${id}-format`}
            labelClassName={SECTION_HEADING}
            value={filters.format ?? ''}
            onValueChange={(v) => go({ format: (v || null) as Format | null })}
            counts={counts?.formats}
            wrapperClassName="w-full"
            className="w-full"
          />
        </div>

        {categories.length > 0 && (
          <div>
            <h2 className={SECTION_HEADING}>Theme</h2>
            <ThemeLinks
              categories={categories}
              chosen={filters.theme}
              hrefOf={(t) => moderationHref(toggleTheme(filters, t))}
              onChoose={(t) => go(toggleTheme(filters, t))}
            />
          </div>
        )}

        {n > 0 && (
          <Link
            href={moderationHref(cleared(filters))}
            onClick={(e) => follow(cleared(filters), e)}
            scroll={false}
            className="inline-flex min-h-11 items-center font-medium text-link hover:text-link-hover"
          >
            Clear filters
          </Link>
        )}
      </section>
    </div>
  );
}

/** The same state and sort, with no search, format or theme. */
const cleared = (f: ListFilters): ListFilters => ({
  ...f,
  q: null,
  format: null,
  theme: null,
});

/** A title search: sent with Enter or the magnifier; an empty one clears it. */
function Search({
  q,
  go,
}: {
  q: string | null;
  go: (next: Partial<ListFilters>) => void;
}) {
  const id = useId();
  const [text, setText] = useState(q ?? '');
  return (
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        const trimmed = text.trim();
        go({ q: trimmed === '' ? null : trimmed });
      }}
    >
      <label htmlFor={id} className="sr-only">
        Search titles
      </label>
      {/* The site's search box (BS-4 B: the list keeps its layout, sharing the box). */}
      <SearchBox
        id={id}
        value={text}
        maxLength={100}
        onChange={(e) => setText(e.target.value)}
        placeholder="Search titles…"
        autoComplete="off"
      />
    </form>
  );
}

function FormatIcon({ format }: { format: Format }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-surface text-secondary-text"
    >
      <svg
        viewBox="0 0 24 24"
        className="size-3.5 fill-none stroke-current"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {format === 'video' ? (
          <path d="M8 5v14l11-7z" className="fill-current" />
        ) : format === 'audio' ? (
          <>
            <path d="M9 18V5l11-2v13" />
            <circle cx="6" cy="18" r="3" />
            <circle cx="17" cy="16" r="3" />
          </>
        ) : (
          <path d="M5 6h14M5 10h14M5 14h14M5 18h9" />
        )}
      </svg>
    </span>
  );
}

/** OQ-2: orange after 2 days and red after 7, on Waiting for review only (AA as text, both themes). */
const ALERT = {
  late: 'font-semibold text-warning',
  // Danger words: in dark, the red lightened 25% (4.8:1 or more on every surface a row sits on).
  overdue: 'font-semibold text-danger-text',
} as const;

function List({
  filters,
  loaded,
  more,
  follow,
}: {
  filters: ListFilters;
  loaded: Loaded;
  more: () => void;
  follow: (to: ListFilters, e: MouseEvent<HTMLAnchorElement>) => void;
}) {
  if (loaded.status === 'loading') {
    return <p className="text-secondary-text">Loading the stories…</p>;
  }
  if (loaded.status === 'failed') {
    return (
      <Card asChild tone="danger" className="p-6">
        <p
          role="alert"

          data-moderation-error=""
        >
          {loaded.message}
        </p>
      </Card>
    );
  }

  const label =
    LIST_STATES.find((s) => s.state === filters.state)?.label ?? filters.state;
  const sortLabel = SORTS.find((s) => s.sort === filters.sort)?.label ?? '';
  if (loaded.items.length === 0) {
    const filtered = activeFilters(filters) > 0;
    return (
      <Card className="p-6" data-list-empty="">
        <p>
          {filtered ? 'No stories match these filters.' : 'No stories here.'}
        </p>
        {filtered && (
          <Link
            href={moderationHref(cleared(filters))}
            onClick={(e) => follow(cleared(filters), e)}
            scroll={false}
            className="mt-2 inline-flex min-h-11 items-center font-medium text-link hover:text-link-hover"
          >
            Clear filters
          </Link>
        )}
      </Card>
    );
  }
  const waiting = filters.state === 'pending' ? 'Waiting' : 'In this state';
  const head = 'px-2.5 py-2 text-xs font-semibold tracking-wide uppercase';
  // From 1280 px a table, one line per story; below, each row is a small card (title, themes and
  // the waiting time), so nothing scrolls sideways.
  const cell = 'xl:table-cell xl:px-2.5 xl:py-3 xl:align-middle';
  return (
    <section aria-labelledby="list-heading">
      <h2 id="list-heading" className="sr-only">
        {label}, {sortLabel.toLowerCase()}
      </h2>
      <table className="block w-full border-collapse text-left xl:table">
        <thead className="sr-only xl:not-sr-only xl:table-header-group">
          <tr className="border-b border-border bg-raised text-secondary-text">
            <th scope="col" className={head}>
              Title
            </th>
            <th scope="col" className={head}>
              State
            </th>
            <th scope="col" className={head}>
              Themes
            </th>
            <th scope="col" className={`${head} whitespace-nowrap`}>
              {waiting}
            </th>
            <th scope="col" className={head}>
              Sent
            </th>
            <th scope="col" className={`${head} whitespace-nowrap`}>
              Last changed
            </th>
          </tr>
        </thead>
        <tbody
          className="block space-y-3 xl:table-row-group xl:space-y-0"
          data-list=""
        >
          {loaded.items.map((s) => {
            const alert = waitingAlert(s.state, s.since, loaded.now);
            return (
              <tr
                key={s.id}
                className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 rounded-xl border border-border bg-card p-3 xl:table-row xl:rounded-none xl:border-0 xl:border-b xl:bg-transparent xl:p-0 xl:hover:bg-raised"
                data-list-item={s.id}
              >
                <td
                  className={`col-span-2 ${cell} [overflow-wrap:anywhere] xl:min-w-48`}
                >
                  <span className="flex items-center gap-2">
                    <FormatIcon format={s.primaryFormat} />
                    <span className="sr-only">
                      {FORMAT_LABEL[s.primaryFormat]}:{' '}
                    </span>
                    <Link
                      href={`/moderation/${encodeURIComponent(s.id)}`}
                      className="inline-flex min-h-11 min-w-0 items-center font-semibold"
                      data-list-title=""
                    >
                      {s.title}
                    </Link>
                  </span>
                </td>
                <td
                  // On a card, only "a problem on our side" shows here (the tab names the state).
                  className={`${s.mediaProblem === 'ours' ? '' : 'hidden'} col-span-2 ${cell} xl:w-44 2xl:w-52`}
                  data-list-state=""
                >
                  <span className="hidden rounded-full border border-brand/40 bg-accent px-2.5 py-0.5 text-sm font-medium text-foreground xl:inline-block">
                    {stateLabel(s.state, s.action)}
                  </span>
                  {s.mediaProblem === 'ours' && (
                    // Part 1a (P1-5, P1-9): our own give-ups, never the person's file.
                    <span
                      className="block text-sm font-semibold text-secondary-text xl:mt-1"
                      data-list-problem="ours"
                    >
                      {s.state === 'pending'
                        ? 'Can’t be reviewed yet: a problem on our side'
                        : 'A problem on our side'}
                    </span>
                  )}
                </td>
                <td className={`${cell} min-w-0`} data-list-themes="">
                  {s.themes.length > 0 ? (
                    <ul className="flex flex-wrap gap-1" aria-label="Themes">
                      {s.themes.map((t) => (
                        <li
                          key={t.id}
                          className="max-w-full rounded-full border border-border px-2 py-0.5 text-sm [overflow-wrap:anywhere] text-secondary-text"
                        >
                          {t.name}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span className="text-sm text-muted-foreground">
                      No themes
                    </span>
                  )}
                </td>
                <td
                  className={`${cell} self-start text-right text-sm whitespace-nowrap xl:text-left`}
                  data-list-waiting={alert ?? ''}
                >
                  <span className="sr-only xl:hidden">{waiting}: </span>
                  <span className={alert ? ALERT[alert] : undefined}>
                    {waitingFor(s.since, loaded.now)}
                  </span>
                </td>
                <td
                  className={`hidden ${cell} text-sm whitespace-nowrap`}
                  data-list-sent=""
                >
                  {s.sentAt ? (
                    <time dateTime={s.sentAt}>{listTime(s.sentAt)}</time>
                  ) : (
                    <span className="text-muted-foreground">Never sent</span>
                  )}
                </td>
                <td
                  className={`hidden ${cell} text-sm whitespace-nowrap text-secondary-text`}
                  data-list-changed=""
                >
                  <time dateTime={s.updatedAt}>{listTime(s.updatedAt)}</time>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {loaded.next && (
        <div className="mt-6 space-y-3">
          {loaded.more && loaded.more !== 'loading' && (
            <p role="alert" className="text-danger-text">
              {loaded.more}
            </p>
          )}
          <Button
            type="button"
            variant="outline"
            wrap
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
