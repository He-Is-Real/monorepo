'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FORMAT_LABELS } from '@heisreal/story-filters';
import { Button, chipVariants, Dialog, Switch } from '@heisreal/web-ui';
import { FavouritesList } from '@/components/favourites/favourites-list';
import {
  type BrowseFilters,
  browseHref,
  FAVOURITES_PARAM,
  favouritesOn,
} from '@/lib/browse-query';

// The filters are a column beside the stories (BS-1 C) from 1024 px screens, small laptops and
// landscape tablets (BS-5 B, Joel 2026-11-21); phones and portrait tablets get the Filters
// button. The `lg:@min-[50rem]:` classes below: the screen at least 64rem (1024 px at the usual
// text size, `lg`) and the block holding the filters and stories (the `browse` container) at
// least 50rem, so larger text (a browser setting, or the page's root size at 200%) gives the
// Filters button instead of story columns squeezed beside a wider column. Beside the column the stories take 2 columns until the
// block is 70rem wide (about 1200 px screens), then 3 as before (lib/masonry.ts,
// BESIDE_FILTERS, which repeats both widths).
//
// Wide screens (BS-8 B, Joel 2026-11-21). The page (stories/page.tsx's <main>, the `browse-page`
// container) is the screen's full width; the block holding the heading, filters and stories (the
// `browse` container) is capped and centred in it, growing past the site's width by up to two
// filters columns (15rem + 2.5rem gap each):
// - below 87.5rem of page (about 1480 px screens): the site's content width, as on every page;
// - from 87.5rem: the filters column plus a story list as wide as the site's content, centred
//   together (the heading lines up with the filters);
// - from 105rem (about 1760 px screens): a third, empty column the filters' width on the right, so
//   the story list (and the heading above it) is centred exactly like Home's content and the
//   filters sit to its left, outside the site's width.
// The thresholds are in rem so larger text keeps the narrower layouts (and its Filters button);
// the widths are the site's width (1200 px, `--container-site`) plus rem, so the story list is
// exactly Home's content at any text size.

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
 * From 1024 px screens (BS-5 B) "Favourites
 * only", sort, format and every theme are a column on the left and only the search box sits above
 * the stories. On portrait tablets and phones a "Filters"
 * button beside the search box (with a count of what's on) opens the same filters in a modal
 * panel, and what's chosen shows under the search box as chips, each removable, with "Clear
 * all". The filters are rendered once: in the column, or moved into the open panel. Without
 * JavaScript there is no panel, so the column shows above the stories at every width.
 *
 * "Favourites only" shows the person's hearted stories in place of browse's list: signed in, the
 * account's; signed out, the hearts kept in this browser (FV-1, Joel 2026-11-14). The switch
 * shows from the first moment for everyone and works at once (BS-9, Joel 2026-11-21); turned on
 * before the browser knows who is looking, the favourites wait (FavouritesList's loading space).
 * Without JavaScript there is no switch. It is kept in the URL (`?favourites=1`), so Back from a
 * story and reloads keep it. Nothing personal is on the server (D32): its page has the switch and
 * the empty loading space, never anyone's favourites. The search, sort, format and theme filters stay and filter the
 * favourites too, in the browser (FV-2 B, Joel 2026-11-14; lib/favourites-filter.ts); every
 * browse address the browser builds keeps the switch (browseHref).
 */
export function BrowseView({
  heading,
  query,
  themeIds,
  chosenThemes,
  search,
  panel,
  summary,
  results,
}: {
  /** The page's heading, above the search box (lined up with the stories on wide screens). */
  heading: ReactNode;
  /** The address's filters, which favourites are filtered by too. */
  query: BrowseFilters;
  /** The themes browse lists, or null when they couldn't be read (favourites-filter.ts). */
  themeIds: readonly string[] | null;
  /** The chosen themes browse lists, with their names. */
  chosenThemes: { id: string; name: string }[];
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
  const params = useSearchParams();
  const on = favouritesOn(params);

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
  const page = useRef<HTMLDivElement>(null);
  const [body, setBody] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const el = dialog.current;
    // Wide enough for the column (the button is gone): the panel isn't needed any more.
    const watch = new ResizeObserver(() => {
      if (button.current && getComputedStyle(button.current).display === 'none')
        el?.close();
    });
    if (page.current) watch.observe(page.current);
    return () => watch.disconnect();
  }, [open]);

  const defaultSort = query.q ? 'relevance' : 'latest';
  const keep = { favourites: on };
  const chosen: Chosen[] = [
    // One chip per chosen theme (BS-6 B), each taking only that theme off.
    ...chosenThemes.map((t) => ({
      key: `theme-${t.id}`,
      label: t.name,
      href: browseHref(
        { ...query, themes: query.themes.filter((id) => id !== t.id) },
        keep,
      ),
    })),
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
    themes: [],
    format: null,
    sort: defaultSort,
  });

  const filters = (
    <div className="space-y-6">
      {/* A switch with its words: the whole row is the target (44 px high). It acts at once
          (SW-1 B). There from the first moment (BS-9), so the filters below never move; it
          needs JavaScript, so without it there is none. */}
      <Switch
        checked={on}
        onCheckedChange={set}
        data-favourites-only=""
        className="noscript:hidden"
      >
        Favourites only
      </Switch>
      {panel}
    </div>
  );

  return (
    <>
      {/* DOM order is search, filters, stories (the keyboard's order); on a computer the
          filters column sits to the left of both. */}
      <div className="@container/browse-page">
        <div
          ref={page}
          className="@container/browse mx-auto max-w-[calc(var(--container-site)-2rem)] sm:max-w-[calc(var(--container-site)-5rem)] @min-[87.5rem]/browse-page:max-w-[calc(var(--container-site)+12.5rem)] @min-[105rem]/browse-page:max-w-[calc(var(--container-site)+30rem)]"
        >
          <div className="lg:@min-[50rem]:grid lg:@min-[50rem]:grid-cols-[15rem_minmax(0,1fr)] lg:@min-[50rem]:grid-rows-[auto_auto_1fr] lg:@min-[50rem]:gap-x-10 @min-[105rem]/browse-page:grid-cols-[15rem_minmax(0,1fr)_15rem]">
            <div
              className="lg:@min-[50rem]:col-span-full lg:@min-[50rem]:row-start-1 @min-[105rem]/browse-page:col-[2]"
              data-browse-heading=""
            >
              {heading}
            </div>
            <div className="min-w-0 lg:@min-[50rem]:col-start-2 lg:@min-[50rem]:row-start-2">
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
                  className="h-11 px-4 lg:@min-[50rem]:hidden noscript:hidden"
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
                  className="mt-3 flex flex-wrap items-center gap-2 lg:@min-[50rem]:hidden"
                  data-chosen-filters=""
                >
                  {chosen.map((c) => (
                    <li key={c.key}>
                      {'href' in c ? (
                        <Link
                          href={c.href}
                          scroll={false}
                          className={`${chipVariants({ chosen: true })} gap-2`}
                        >
                          <ChipText label={c.label} />
                        </Link>
                      ) : (
                        <button
                          type="button"
                          onClick={c.onRemove}
                          className={`${chipVariants({ chosen: true })} gap-2`}
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
              className="mt-6 hidden lg:@min-[50rem]:col-start-1 lg:@min-[50rem]:row-span-2 lg:@min-[50rem]:row-start-2 lg:@min-[50rem]:mt-0 lg:@min-[50rem]:block noscript:block"
              data-filters-column=""
            >
              {open && body ? createPortal(filters, body) : !open && filters}
            </aside>

            <div className="min-w-0 lg:@min-[50rem]:col-start-2 lg:@min-[50rem]:row-start-3">
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
        </div>
      </div>

      {/* Tablets and phones: the filters in a modal panel (a bottom sheet on phones). The native
          dialog keeps focus inside, closes with Escape and gives focus back to the button. */}
      <Dialog
        ref={dialog}
        id={`${id}-panel`}
        title="Filters"
        closeLabel="Close filters"
        open={open}
        closeOnOutsideClick
        onClose={() => {
          setOpen(false);
          button.current?.focus();
        }}
        bodyRef={setBody}
        data-filters-panel=""
        footer={
          <>
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
            <Button type="button" onClick={() => dialog.current?.close()}>
              Show stories
            </Button>
          </>
        }
      />
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
