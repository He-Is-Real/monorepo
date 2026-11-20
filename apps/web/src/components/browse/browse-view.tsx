'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FORMAT_LABELS } from '@heisreal/story-filters';
import { Button } from '@heisreal/web-ui';
import { FavouritesList } from '@/components/favourites/favourites-list';
import { THEME_CHIP_ON } from '@/components/themes/theme-chip';
import {
  type BrowseFilters,
  browseHref,
  FAVOURITES_PARAM,
  favouritesOn,
} from '@/lib/browse-query';
import { usePersonalSession } from '@/lib/personal-session';

/** Tailwind's `xl`: from here the filters are a column beside the stories (BS-1 C). */
const WIDE = '(min-width: 80rem)';

const SORT_LABELS = {
  latest: 'Latest first',
  oldest: 'Oldest first',
  relevance: 'Best match',
} as const;

/** One chosen filter, shown as a removable chip on tablets and phones. */
type Chosen = { key: string; label: string } & (
  { href: string } | { onRemove: () => void }
);

/**
 * Browse's layout (BS-1 C, Joel 2026-11-20) and "Favourites only" (Joel, 2026-11-14; it replaces
 * the My favourites page).
 *
 * On a computer (1280 px and up) "Favourites only", sort, format and every theme are a column on
 * the left and only the search box sits above the stories. On tablets and phones a "Filters"
 * button beside the search box (with a count of what's on) opens the same filters in a modal
 * panel, and what's chosen shows under the search box as chips, each removable, with "Clear
 * all". The filters are rendered once: in the column, or moved into the open panel. Without
 * JavaScript there is no panel, so the column shows above the stories at every width.
 *
 * "Favourites only" shows the person's hearted stories in place of browse's list: signed in, the
 * account's; signed out, the hearts kept in this browser (FV-1, Joel 2026-11-14). Until the
 * browser knows which (or without JavaScript) there is no switch and browse is as it always was.
 * The switch is kept in the URL (`?favourites=1`), so Back from a story and reloads keep it.
 * web's server renders the same page whatever it says (D32: nothing personal on the server); the
 * browser alone reads it. The search, sort, format and theme filters stay and filter the
 * favourites too, in the browser (FV-2 B, Joel 2026-11-14; lib/favourites-filter.ts); every
 * browse address the browser builds keeps the switch (browseHref).
 */
export function BrowseView({
  query,
  themeIds,
  themeName,
  search,
  panel,
  summary,
  results,
}: {
  /** The address's filters, which favourites are filtered by too. */
  query: BrowseFilters;
  /** The themes browse lists, or null when they couldn't be read (favourites-filter.ts). */
  themeIds: readonly string[] | null;
  /** The chosen theme's name, if it's one browse lists. */
  themeName: string | null;
  /** The search box. */
  search: ReactNode;
  /** Sort, format and the themes. */
  panel: ReactNode;
  /** What the list shows, in words, when filtered. */
  summary: ReactNode;
  /**
   * Browse's list. Gone while favourites show; back, it reloads the pages the URL says were
   * loaded (`?pages=`, as after Back).
   */
  results: ReactNode;
}) {
  const session = usePersonalSession();
  const params = useSearchParams();
  const known = session.status !== 'unknown';
  const on = known && favouritesOn(params);

  const set = (next: boolean) => {
    const url = new URL(window.location.href);
    if (next) url.searchParams.set(FAVOURITES_PARAM, '1');
    else url.searchParams.delete(FAVOURITES_PARAM);
    // Next keeps its router (and useSearchParams) in step with the History API.
    window.history.replaceState(null, '', `${url.pathname}${url.search}`);
  };

  const id = useId();
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const [body, setBody] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const el = dialog.current;
    if (el && !el.open) el.showModal();
    // Wide enough for the column: the panel isn't needed any more.
    const wide = matchMedia(WIDE);
    const onWide = () => wide.matches && el?.close();
    wide.addEventListener('change', onWide);
    return () => wide.removeEventListener('change', onWide);
  }, [open]);

  const defaultSort = query.q ? 'relevance' : 'latest';
  const keep = { favourites: on };
  const chosen: Chosen[] = [
    ...(themeName
      ? [
          {
            key: 'theme',
            label: themeName,
            href: browseHref({ ...query, theme: null }, keep),
          },
        ]
      : []),
    ...(query.format
      ? [
          {
            key: 'format',
            label: FORMAT_LABELS[query.format],
            href: browseHref({ ...query, format: null }, keep),
          },
        ]
      : []),
    ...(query.sort !== defaultSort
      ? [
          {
            key: 'sort',
            label: SORT_LABELS[query.sort],
            href: browseHref({ ...query, sort: defaultSort }, keep),
          },
        ]
      : []),
    ...(on
      ? [
          {
            key: 'favourites',
            label: 'Favourites only',
            onRemove: () => set(false),
          },
        ]
      : []),
  ];
  const clearAll = browseHref({
    q: query.q,
    theme: null,
    format: null,
    sort: defaultSort,
  });

  const filters = (
    <div className="space-y-6">
      {known && (
        // A switch with its words: the whole row is the target (44 px high).
        <button
          type="button"
          role="switch"
          aria-checked={on}
          onClick={() => set(!on)}
          data-favourites-only=""
          className="group inline-flex min-h-11 items-center gap-3 rounded-lg pr-2 font-medium text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <span
            aria-hidden="true"
            className="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-border-hover bg-input-background transition-colors group-aria-checked:border-brand group-aria-checked:bg-brand motion-reduce:transition-none"
          >
            <span className="ml-0.5 size-5 rounded-full bg-secondary-text shadow transition-transform group-aria-checked:translate-x-5 group-aria-checked:bg-on-media motion-reduce:transition-none" />
          </span>
          Favourites only
        </button>
      )}
      {panel}
    </div>
  );

  return (
    <>
      {/* DOM order is search, filters, stories (the keyboard's order); on a computer the
          filters column sits to the left of both. */}
      <div className="xl:grid xl:grid-cols-[15rem_minmax(0,1fr)] xl:grid-rows-[auto_1fr] xl:gap-x-10">
        <div className="min-w-0 xl:col-start-2 xl:row-start-1">
          <div className="flex items-start gap-3">
            {search}
            <Button
              ref={button}
              type="button"
              variant="outline"
              aria-haspopup="dialog"
              aria-expanded={open}
              aria-controls={`${id}-panel`}
              onClick={() => setOpen(true)}
              data-filters-button=""
              className="h-11 px-4 xl:hidden noscript:hidden"
            >
              <svg
                viewBox="0 0 24 24"
                aria-hidden="true"
                className="fill-none stroke-current"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
                <circle cx="16" cy="7" r="2" />
                <circle cx="10" cy="17" r="2" />
              </svg>
              Filters
              {chosen.length > 0 && (
                <>
                  <span
                    aria-hidden="true"
                    className="inline-grid h-5 min-w-5 place-items-center rounded-full bg-primary px-1.5 text-xs font-semibold text-primary-foreground"
                  >
                    {chosen.length}
                  </span>
                  <span className="sr-only">({chosen.length} on)</span>
                </>
              )}
            </Button>
          </div>
          {chosen.length > 0 && (
            <ul
              aria-label="Chosen filters"
              className="mt-3 flex flex-wrap items-center gap-2 xl:hidden"
              data-chosen-filters=""
            >
              {chosen.map((c) => (
                <li key={c.key}>
                  {'href' in c ? (
                    <Link
                      href={c.href}
                      scroll={false}
                      className={`${THEME_CHIP_ON} gap-2`}
                    >
                      <ChipText label={c.label} />
                    </Link>
                  ) : (
                    <button
                      type="button"
                      onClick={c.onRemove}
                      className={`${THEME_CHIP_ON} gap-2`}
                    >
                      <ChipText label={c.label} />
                    </button>
                  )}
                </li>
              ))}
              <li>
                <Link
                  href={clearAll}
                  scroll={false}
                  className="inline-flex min-h-11 items-center px-2 text-sm font-medium"
                >
                  Clear all
                </Link>
              </li>
            </ul>
          )}
        </div>

        <aside
          aria-label="Filters"
          className="mt-6 hidden xl:col-start-1 xl:row-span-2 xl:row-start-1 xl:mt-0 xl:block noscript:block"
          data-filters-column=""
        >
          {open && body ? createPortal(filters, body) : !open && filters}
        </aside>

        <div className="min-w-0 xl:col-start-2 xl:row-start-2">
          {summary}
          <div className="mt-8">
            {on && (
              <FavouritesList
                filters={query}
                themeIds={themeIds}
                onShowAll={() => set(false)}
              />
            )}
            {!on && results}
          </div>
        </div>
      </div>

      {/* Tablets and phones: the filters in a modal panel (a bottom sheet on phones). The native
          dialog keeps focus inside, closes with Escape and gives focus back to the button. */}
      <dialog
        ref={dialog}
        id={`${id}-panel`}
        aria-labelledby={`${id}-title`}
        onClose={() => {
          setOpen(false);
          button.current?.focus();
        }}
        onClick={(e) => {
          // A click on the backdrop (the dialog itself, outside its box) closes it.
          if (e.target === e.currentTarget) e.currentTarget.close();
        }}
        className="mx-0 mt-auto mb-0 w-full max-w-full rounded-t-2xl border border-border-hover bg-card p-0 text-foreground backdrop:bg-media/50 sm:m-auto sm:w-[min(100%-4rem,40rem)] sm:rounded-2xl"
        data-filters-panel=""
      >
        <div className="flex max-h-[85svh] flex-col">
          <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-2">
            <h2 id={`${id}-title`} className="text-lg font-semibold">
              Filters
            </h2>
            <button
              type="button"
              onClick={() => dialog.current?.close()}
              className="inline-flex size-11 items-center justify-center rounded-lg text-secondary-text hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              <svg
                viewBox="0 0 24 24"
                aria-hidden="true"
                className="size-5 fill-none stroke-current"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
              <span className="sr-only">Close filters</span>
            </button>
          </div>
          <div
            ref={setBody}
            className="min-h-0 flex-1 overflow-y-auto px-5 py-4"
          />
          <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {chosen.length > 0 ? (
              <Link
                href={clearAll}
                scroll={false}
                className="inline-flex min-h-11 items-center text-sm font-medium"
              >
                Clear all
              </Link>
            ) : (
              <span />
            )}
            <Button
              type="button"
              onClick={() => dialog.current?.close()}
              className="h-11 px-5"
            >
              Show stories
            </Button>
          </div>
        </div>
      </dialog>
    </>
  );
}

function ChipText({ label }: { label: string }) {
  return (
    <>
      <span className="sr-only">Remove </span>
      {label}
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        className="size-4 fill-none stroke-current"
        strokeWidth="2.5"
        strokeLinecap="round"
      >
        <path d="M6 6l12 12M18 6 6 18" />
      </svg>
    </>
  );
}
